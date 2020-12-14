/**
 *
 */
import EventEmitter from 'events';
import jsforce from './jsforce';
import {
  HttpRequest,
  HttpResponse,
  Callback,
  Record,
  SaveResult,
  DescribeGlobalResult,
  DescribeSObjectResult,
  DescribeTab,
  DescribeTheme,
  DescribeQuickActionResult,
  UpdatedResult,
  DeletedResult,
  OrganizationLimitsInfo,
  Optional,
  SignedRequestObject,
  SaveError,
  DmlOptions,
  RetrieveOptions,
  Schema,
  SObjectNames,
  SObjectInputRecord,
  SObjectUpdateRecord,
  SObjectFieldNames,
} from './types';
import { StreamPromise } from './util/promise';
import Transport, {
  CanvasTransport,
  XdProxyTransport,
  HttpProxyTransport,
} from './transport';
import { Logger, getLogger } from './util/logger';
import { LogLevelConfig } from './util/logger';
import OAuth2, { TokenResponse } from './oauth2';
import { OAuth2Config } from './oauth2';
import Cache, { CachedFunction } from './cache';
import HttpApi from './http-api';
import SessionRefreshDelegate, {
  SessionRefreshFunc,
} from './session-refresh-delegate';
import Query from './query';
import { QueryOptions } from './query';
import SObject from './sobject';
import QuickAction from './quick-action';
import { formatDate } from './util/formatter';
import Analytics from './api/analytics';
import Apex from './api/apex';
import Bulk from './api/bulk';
import Chatter from './api/chatter';
import Metadata from './api/metadata';
import SoapApi from './api/soap';
import Streaming from './api/streaming';
import Tooling from './api/tooling';

/**
 * type definitions
 */
export type ConnectionConfig<S extends Schema> = {
  version?: string;
  loginUrl?: string;
  accessToken?: string;
  refreshToken?: string;
  instanceUrl?: string;
  sessionId?: string;
  serverUrl?: string;
  signedRequest?: string;
  oauth2?: OAuth2 | OAuth2Config;
  maxRequest?: number;
  proxyUrl?: string;
  httpProxy?: string;
  logLevel?: LogLevelConfig;
  callOptions?: { [name: string]: string };
  refreshFn?: SessionRefreshFunc<S>;
};

export type UserInfo = {
  id: string;
  organizationId: string;
  url: string;
};

export type LimitInfo = {
  apiUsage?: {
    used: number;
    limit: number;
  };
};

export type ConnectionEstablishOptions = {
  accessToken?: Optional<string>;
  refreshToken?: Optional<string>;
  instanceUrl?: Optional<string>;
  sessionId?: Optional<string>;
  serverUrl?: Optional<string>;
  signedRequest?: Optional<string | SignedRequestObject>;
  userInfo?: Optional<UserInfo>;
};

/**
 *
 */
const defaultConnectionConfig: {
  loginUrl: string;
  instanceUrl: string;
  version: string;
  logLevel: LogLevelConfig;
  maxRequest: number;
} = {
  loginUrl: 'https://login.salesforce.com',
  instanceUrl: '',
  version: '43.0',
  logLevel: 'NONE',
  maxRequest: 10,
};

/**
 *
 */
function esc(str: Optional<string>): string {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 *
 */
function parseSignedRequest(sr: string | Object): SignedRequestObject {
  if (typeof sr === 'string') {
    if (sr[0] === '{') {
      // might be JSON
      return JSON.parse(sr);
    } // might be original base64-encoded signed request
    const msg = sr.split('.').pop(); // retrieve latter part
    if (!msg) {
      throw new Error('Invalid signed request');
    }
    const json = Buffer.from(msg, 'base64').toString('utf-8');
    return JSON.parse(json);
  }
  return sr as SignedRequestObject;
}

/** @private **/
function parseIdUrl(url: string) {
  const [organizationId, id] = url.split('/').slice(-2);
  return { id, organizationId, url };
}

/**
 * Session Refresh delegate function for OAuth2 authz code flow
 * @private
 */
async function oauthRefreshFn<S extends Schema>(
  conn: Connection<S>,
  callback: Callback<string, TokenResponse>,
) {
  try {
    if (!conn.refreshToken) {
      throw new Error('No refresh token found in the connection');
    }
    const res = await conn.oauth2.refreshToken(conn.refreshToken);
    const userInfo = parseIdUrl(res.id);
    conn._establish({
      instanceUrl: res.instance_url,
      accessToken: res.access_token,
      userInfo,
    });
    callback(undefined, res.access_token, res);
  } catch (err) {
    callback(err);
  }
}

/**
 * Session Refresh delegate function for username/password login
 * @private
 */
function createUsernamePasswordRefreshFn<S extends Schema>(
  username: string,
  password: string,
) {
  return async (
    conn: Connection<S>,
    callback: Callback<string, TokenResponse>,
  ) => {
    try {
      await conn.login(username, password);
      if (!conn.accessToken) {
        throw new Error('Access token not found after login');
      }
      callback(null, conn.accessToken);
    } catch (err) {
      callback(err);
    }
  };
}

/**
 * @private
 */
function toSaveResult(id: Optional<string>, err: SaveError): SaveResult {
  return {
    ...(id ? { id } : {}),
    success: false,
    errors: [err],
  };
}

/**
 *
 */
function raiseNoModuleError(name: string): never {
  throw new Error(
    `API module '${name}' is not loaded, load 'jsforce/api/${name}' explicitly`,
  );
}

/*
 * Constant of maximum records num in DML operation (update/delete)
 */
const MAX_DML_COUNT = 200;

/**
 *
 */
export default class Connection<
  S extends Schema = Schema
> extends EventEmitter {
  static _logger = getLogger('connection');

  version: string;
  loginUrl: string;
  instanceUrl: string;
  accessToken: Optional<string>;
  refreshToken: Optional<string>;
  userInfo: Optional<UserInfo>;
  limitInfo: LimitInfo = {};
  oauth2: OAuth2;
  sobjects: { [N in SObjectNames<S>]?: SObject<S, N> } = {};
  cache: Cache;
  _callOptions: Optional<{ [name: string]: string }>;
  _maxRequest: number;
  _logger: Logger;
  _logLevel: Optional<LogLevelConfig>;
  _transport: Transport;
  _sessionType: Optional<'soap' | 'oauth2'>;
  _refreshDelegate: Optional<SessionRefreshDelegate<S>>;

  // describe: (name: string) => Promise<DescribeSObjectResult>;
  describe$: CachedFunction<(name: string) => Promise<DescribeSObjectResult>>;
  describe$$: CachedFunction<(name: string) => DescribeSObjectResult>;
  describeSObject: (name: string) => Promise<DescribeSObjectResult>;
  describeSObject$: CachedFunction<
    (name: string) => Promise<DescribeSObjectResult>
  >;
  describeSObject$$: CachedFunction<(name: string) => DescribeSObjectResult>;
  // describeGlobal: () => Promise<DescribeGlobalResult>;
  describeGlobal$: CachedFunction<() => Promise<DescribeGlobalResult>>;
  describeGlobal$$: CachedFunction<() => DescribeGlobalResult>;

  // API libs are not instantiated here so that core module to remain without dependencies to them
  // It is responsible for develpers to import api libs explicitly if they are using 'jsforce/core' instead of 'jsforce'.
  get analytics(): Analytics<S> {
    return raiseNoModuleError('analytics');
  }

  get apex(): Apex<S> {
    return raiseNoModuleError('apex');
  }

  get bulk(): Bulk<S> {
    return raiseNoModuleError('bulk');
  }

  get chatter(): Chatter<S> {
    return raiseNoModuleError('chatter');
  }

  get metadata(): Metadata<S> {
    return raiseNoModuleError('metadata');
  }

  get soap(): SoapApi<S> {
    return raiseNoModuleError('soap');
  }

  get streaming(): Streaming<S> {
    return raiseNoModuleError('streaming');
  }

  get tooling(): Tooling<S> {
    return raiseNoModuleError('tooling');
  }

  /**
   *
   */
  constructor(config: ConnectionConfig<S> = {}) {
    super();
    const {
      loginUrl,
      instanceUrl,
      version,
      oauth2,
      maxRequest,
      logLevel,
      proxyUrl,
      httpProxy,
    } = config;
    this.loginUrl = loginUrl || defaultConnectionConfig.loginUrl;
    this.instanceUrl = instanceUrl || defaultConnectionConfig.instanceUrl;
    this.version = version || defaultConnectionConfig.version;
    this.oauth2 = oauth2
      ? oauth2 instanceof OAuth2
        ? oauth2
        : new OAuth2(oauth2)
      : new OAuth2({ loginUrl: this.loginUrl });
    let refreshFn = config.refreshFn;
    if (!refreshFn && this.oauth2.clientId) {
      refreshFn = oauthRefreshFn;
    }
    if (refreshFn) {
      this._refreshDelegate = new SessionRefreshDelegate(this, refreshFn);
    }
    this._maxRequest = maxRequest || defaultConnectionConfig.maxRequest;
    this._logger = logLevel
      ? Connection._logger.createInstance(logLevel)
      : Connection._logger;
    this._logLevel = logLevel;
    this._transport = proxyUrl
      ? new XdProxyTransport(proxyUrl)
      : httpProxy
      ? new HttpProxyTransport(httpProxy)
      : new Transport();
    this._callOptions = config.callOptions;
    this.cache = new Cache();
    const describeCacheKey = (type?: string) =>
      type ? `describe.${type}` : 'describe';
    const describe = Connection.prototype.describe;
    this.describe = this.cache.createCachedFunction(describe, this, {
      key: describeCacheKey,
      strategy: 'NOCACHE',
    });
    this.describe$ = this.cache.createCachedFunction(describe, this, {
      key: describeCacheKey,
      strategy: 'HIT',
    });
    this.describe$$ = this.cache.createCachedFunction(describe, this, {
      key: describeCacheKey,
      strategy: 'IMMEDIATE',
    }) as any;
    this.describeSObject = this.describe;
    this.describeSObject$ = this.describe$;
    this.describeSObject$$ = this.describe$$;
    const describeGlobal = Connection.prototype.describeGlobal;
    this.describeGlobal = this.cache.createCachedFunction(
      describeGlobal,
      this,
      { key: 'describeGlobal', strategy: 'NOCACHE' },
    );
    this.describeGlobal$ = this.cache.createCachedFunction(
      describeGlobal,
      this,
      { key: 'describeGlobal', strategy: 'HIT' },
    );
    this.describeGlobal$$ = this.cache.createCachedFunction(
      describeGlobal,
      this,
      { key: 'describeGlobal', strategy: 'IMMEDIATE' },
    ) as any;
    const {
      accessToken,
      refreshToken,
      sessionId,
      serverUrl,
      signedRequest,
    } = config;
    this._establish({
      accessToken,
      refreshToken,
      instanceUrl,
      sessionId,
      serverUrl,
      signedRequest,
    });

    jsforce.emit('connection:new', this);
  }

  /* @private */
  _establish(options: ConnectionEstablishOptions) {
    const {
      accessToken,
      refreshToken,
      instanceUrl,
      sessionId,
      serverUrl,
      signedRequest,
      userInfo,
    } = options;
    this.instanceUrl = serverUrl
      ? serverUrl.split('/').slice(0, 3).join('/')
      : instanceUrl || this.instanceUrl;
    this.accessToken = sessionId || accessToken || this.accessToken;
    this.refreshToken = refreshToken || this.refreshToken;
    if (this.refreshToken && !this._refreshDelegate) {
      throw new Error(
        'Refresh token is specified without oauth2 client information or refresh function',
      );
    }
    const signedRequestObject =
      signedRequest && parseSignedRequest(signedRequest);
    if (signedRequestObject) {
      this.accessToken = signedRequestObject.client.oauthToken;
      if (CanvasTransport.supported) {
        this._transport = new CanvasTransport(signedRequestObject);
      }
    }
    this.userInfo = userInfo || this.userInfo;
    this._sessionType = sessionId ? 'soap' : 'oauth2';
    this._resetInstance();
  }

  /* @priveate */
  _clearSession() {
    this.accessToken = null;
    this.refreshToken = null;
    this.instanceUrl = defaultConnectionConfig.instanceUrl;
    this.userInfo = null;
    this._sessionType = null;
  }

  /* @priveate */
  _resetInstance() {
    this.limitInfo = {};
    this.sobjects = {};
    // TODO impl cache
    this.cache.clear();
    this.cache.get('describeGlobal').removeAllListeners('value');
    this.cache.get('describeGlobal').on('value', ({ result }) => {
      if (result) {
        for (const so of result.sobjects) {
          this.sobject(so.name);
        }
      }
    });
    /*
    if (this.tooling) {
      this.tooling._resetInstance();
    }
    */
  }

  /**
   * Authorize (using oauth2 web server flow)
   */
  async authorize(
    code: string,
    params: { [name: string]: string } = {},
  ): Promise<UserInfo> {
    const res = await this.oauth2.requestToken(code, params);
    const userInfo = parseIdUrl(res.id);
    this._establish({
      instanceUrl: res.instance_url,
      accessToken: res.access_token,
      refreshToken: res.refresh_token,
      userInfo,
    });
    this._logger.debug(
      `<login> completed. user id = ${userInfo.id}, org id = ${userInfo.organizationId}`,
    );
    return userInfo;
  }

  /**
   *
   */
  async login(username: string, password: string): Promise<UserInfo> {
    this._refreshDelegate = new SessionRefreshDelegate(
      this,
      createUsernamePasswordRefreshFn(username, password),
    );
    if (this.oauth2 && this.oauth2.clientId && this.oauth2.clientSecret) {
      return this.loginByOAuth2(username, password);
    }
    return this.loginBySoap(username, password);
  }

  /**
   * Login by OAuth2 username & password flow
   */
  async loginByOAuth2(username: string, password: string): Promise<UserInfo> {
    const res = await this.oauth2.authenticate(username, password);
    const userInfo = parseIdUrl(res.id);
    this._establish({
      instanceUrl: res.instance_url,
      accessToken: res.access_token,
      userInfo,
    });
    this._logger.info(
      `<login> completed. user id = ${userInfo.id}, org id = ${userInfo.organizationId}`,
    );
    return userInfo;
  }

  /**
   *
   */
  async loginBySoap(username: string, password: string): Promise<UserInfo> {
    if (!username || !password) {
      return Promise.reject(new Error('no username password given'));
    }
    const body = [
      '<se:Envelope xmlns:se="http://schemas.xmlsoap.org/soap/envelope/">',
      '<se:Header/>',
      '<se:Body>',
      '<login xmlns="urn:partner.soap.sforce.com">',
      `<username>${esc(username)}</username>`,
      `<password>${esc(password)}</password>`,
      '</login>',
      '</se:Body>',
      '</se:Envelope>',
    ].join('');

    const soapLoginEndpoint = [
      this.loginUrl,
      'services/Soap/u',
      this.version,
    ].join('/');
    const response = await this._transport.httpRequest({
      method: 'POST',
      url: soapLoginEndpoint,
      body,
      headers: {
        'Content-Type': 'text/xml',
        SOAPAction: '""',
      },
    });
    let m;
    if (response.statusCode >= 400) {
      m = response.body.match(/<faultstring>([^<]+)<\/faultstring>/);
      const faultstring = m && m[1];
      throw new Error(faultstring || response.body);
    }
    this._logger.debug(`SOAP response = ${response.body}`);
    m = response.body.match(/<serverUrl>([^<]+)<\/serverUrl>/);
    const serverUrl = m && m[1];
    m = response.body.match(/<sessionId>([^<]+)<\/sessionId>/);
    const sessionId = m && m[1];
    m = response.body.match(/<userId>([^<]+)<\/userId>/);
    const userId = m && m[1];
    m = response.body.match(/<organizationId>([^<]+)<\/organizationId>/);
    const organizationId = m && m[1];
    if (!serverUrl || !sessionId || !userId || !organizationId) {
      throw new Error(
        'could not extract session information from login response',
      );
    }
    const idUrl = [this.loginUrl, 'id', organizationId, userId].join('/');
    const userInfo = { id: userId, organizationId, url: idUrl };
    this._establish({
      serverUrl: serverUrl.split('/').slice(0, 3).join('/'),
      sessionId,
      userInfo,
    });
    this._logger.info(
      `<login> completed. user id = ${userId}, org id = ${organizationId}`,
    );
    return userInfo;
  }

  /**
   * Logout the current session
   */
  async logout(revoke?: boolean): Promise<void> {
    this._refreshDelegate = undefined;
    if (this._sessionType === 'oauth2') {
      return this.logoutByOAuth2(revoke);
    }
    return this.logoutBySoap(revoke);
  }

  /**
   * Logout the current session by revoking access token via OAuth2 session revoke
   */
  async logoutByOAuth2(revoke?: boolean): Promise<void> {
    const token = revoke ? this.refreshToken : this.accessToken;
    if (token) {
      await this.oauth2.revokeToken(token);
    }
    // Destroy the session bound to this connection
    this._clearSession();
    this._resetInstance();
  }

  /**
   * Logout the session by using SOAP web service API
   */
  async logoutBySoap(revoke?: boolean): Promise<void> {
    const body = [
      '<se:Envelope xmlns:se="http://schemas.xmlsoap.org/soap/envelope/">',
      '<se:Header>',
      '<SessionHeader xmlns="urn:partner.soap.sforce.com">',
      `<sessionId>${esc(
        revoke ? this.refreshToken : this.accessToken,
      )}</sessionId>`,
      '</SessionHeader>',
      '</se:Header>',
      '<se:Body>',
      '<logout xmlns="urn:partner.soap.sforce.com"/>',
      '</se:Body>',
      '</se:Envelope>',
    ].join('');
    const response = await this._transport.httpRequest({
      method: 'POST',
      url: [this.instanceUrl, 'services/Soap/u', this.version].join('/'),
      body,
      headers: {
        'Content-Type': 'text/xml',
        SOAPAction: '""',
      },
    });
    this._logger.debug(
      `SOAP statusCode = ${response.statusCode}, response = ${response.body}`,
    );
    if (response.statusCode >= 400) {
      const m = response.body.match(/<faultstring>([^<]+)<\/faultstring>/);
      const faultstring = m && m[1];
      throw new Error(faultstring || response.body);
    }
    // Destroy the session bound to this connection
    this._clearSession();
    this._resetInstance();
  }

  /**
   * Send REST API request with given HTTP request info, with connected session information.
   *
   * Endpoint URL can be absolute URL ('https://na1.salesforce.com/services/data/v32.0/sobjects/Account/describe')
   * , relative path from root ('/services/data/v32.0/sobjects/Account/describe')
   * , or relative path from version root ('/sobjects/Account/describe').
   */
  request<R = any>(
    request: string | HttpRequest,
    options: Object = {},
  ): StreamPromise<R> {
    // if request is simple string, regard it as url in GET method
    let request_: HttpRequest =
      typeof request === 'string' ? { method: 'GET', url: request } : request;
    // if url is given in relative path, prepend base url or instance url before.
    request_ = {
      ...request_,
      url: this._normalizeUrl(request_.url),
    };
    const httpApi = new HttpApi(this, options);
    // log api usage and its quota
    httpApi.on('response', (response: HttpResponse) => {
      if (response.headers && response.headers['sforce-limit-info']) {
        const apiUsage = response.headers['sforce-limit-info'].match(
          /api-usage=(\d+)\/(\d+)/,
        );
        if (apiUsage) {
          this.limitInfo = {
            apiUsage: {
              used: parseInt(apiUsage[1], 10),
              limit: parseInt(apiUsage[2], 10),
            },
          };
        }
      }
    });
    return httpApi.request<R>(request_);
  }

  /**
   * Send HTTP GET request
   *
   * Endpoint URL can be absolute URL ('https://na1.salesforce.com/services/data/v32.0/sobjects/Account/describe')
   * , relative path from root ('/services/data/v32.0/sobjects/Account/describe')
   * , or relative path from version root ('/sobjects/Account/describe').
   */
  requestGet<R = any>(url: string, options?: Object) {
    const request: HttpRequest = { method: 'GET', url };
    return this.request<R>(request, options);
  }

  /**
   * Send HTTP POST request with JSON body, with connected session information
   *
   * Endpoint URL can be absolute URL ('https://na1.salesforce.com/services/data/v32.0/sobjects/Account/describe')
   * , relative path from root ('/services/data/v32.0/sobjects/Account/describe')
   * , or relative path from version root ('/sobjects/Account/describe').
   */
  requestPost<R = any>(url: string, body: Object, options?: Object) {
    const request: HttpRequest = {
      method: 'POST',
      url,
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    };
    return this.request<R>(request, options);
  }

  /**
   * Send HTTP PUT request with JSON body, with connected session information
   *
   * Endpoint URL can be absolute URL ('https://na1.salesforce.com/services/data/v32.0/sobjects/Account/describe')
   * , relative path from root ('/services/data/v32.0/sobjects/Account/describe')
   * , or relative path from version root ('/sobjects/Account/describe').
   */
  requestPut<R>(url: string, body: Object, options?: Object) {
    const request: HttpRequest = {
      method: 'PUT',
      url,
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    };
    return this.request<R>(request, options);
  }

  /**
   * Send HTTP PATCH request with JSON body
   *
   * Endpoint URL can be absolute URL ('https://na1.salesforce.com/services/data/v32.0/sobjects/Account/describe')
   * , relative path from root ('/services/data/v32.0/sobjects/Account/describe')
   * , or relative path from version root ('/sobjects/Account/describe').
   */
  requestPatch<R = any>(url: string, body: Object, options?: Object) {
    const request: HttpRequest = {
      method: 'PATCH',
      url,
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    };
    return this.request<R>(request, options);
  }

  /**
   * Send HTTP DELETE request
   *
   * Endpoint URL can be absolute URL ('https://na1.salesforce.com/services/data/v32.0/sobjects/Account/describe')
   * , relative path from root ('/services/data/v32.0/sobjects/Account/describe')
   * , or relative path from version root ('/sobjects/Account/describe').
   */
  requestDelete<R>(url: string, options?: Object) {
    const request: HttpRequest = { method: 'DELETE', url };
    return this.request<R>(request, options);
  }

  /** @private **/
  _baseUrl() {
    return [this.instanceUrl, 'services/data', `v${this.version}`].join('/');
  }

  /**
   * Convert path to absolute url
   * @private
   */
  _normalizeUrl(url: string) {
    if (url[0] === '/') {
      if (url.indexOf('/services/') === 0) {
        return this.instanceUrl + url;
      }
      return this._baseUrl() + url;
    }
    return url;
  }

  /**
   *
   */
  query(soql: string, options?: Partial<QueryOptions>) {
    return new Query<S, SObjectNames<S>, Record, 'QueryResult'>(
      this,
      soql,
      options,
    );
  }

  /**
   *
   */
  queryMore(locator: string, options?: QueryOptions) {
    return new Query<S, SObjectNames<S>, Record, 'QueryResult'>(
      this,
      { locator },
      options,
    );
  }

  /* */
  _ensureVersion(majorVersion: number) {
    const versions = this.version.split('.');
    return parseInt(versions[0], 10) >= majorVersion;
  }

  /* */
  _supports(feature: string) {
    switch (feature) {
      case 'sobject-collection': // sobject collection is available only in API ver 42.0+
        return this._ensureVersion(42);
      default:
        return false;
    }
  }

  /**
   * Retrieve specified records
   */
  retrieve<N extends SObjectNames<S>>(
    type: N,
    ids: string,
    options?: RetrieveOptions,
  ): Promise<Record>;
  retrieve<N extends SObjectNames<S>>(
    type: N,
    ids: string[],
    options?: RetrieveOptions,
  ): Promise<Record[]>;
  retrieve<N extends SObjectNames<S>>(
    type: N,
    ids: string | string[],
    options?: RetrieveOptions,
  ): Promise<Record | Record[]>;
  async retrieve(
    type: string,
    ids: string | string[],
    options: RetrieveOptions = {},
  ) {
    return Array.isArray(ids)
      ? // check the version whether SObject collection API is supported (42.0)
        this._ensureVersion(42)
        ? this._retrieveMany(type, ids, options)
        : this._retrieveParallel(type, ids, options)
      : this._retrieveSingle(type, ids, options);
  }

  /** @private */
  async _retrieveSingle(type: string, id: string, options: RetrieveOptions) {
    if (!id) {
      throw new Error('Invalid record ID. Specify valid record ID value');
    }
    let url = [this._baseUrl(), 'sobjects', type, id].join('/');
    const { fields, headers } = options;
    if (fields) {
      url += `?fields=${fields.join(',')}`;
    }
    return this.request({ method: 'GET', url, headers });
  }

  /** @private */
  async _retrieveParallel(
    type: string,
    ids: string[],
    options: RetrieveOptions,
  ) {
    if (ids.length > this._maxRequest) {
      throw new Error('Exceeded max limit of concurrent call');
    }
    return Promise.all(
      ids.map((id) =>
        this._retrieveSingle(type, id, options).catch((err) => {
          if (options.allOrNone || err.errorCode !== 'NOT_FOUND') {
            throw err;
          }
          return null;
        }),
      ),
    );
  }

  /** @private */
  async _retrieveMany(type: string, ids: string[], options: RetrieveOptions) {
    if (ids.length === 0) {
      return [];
    }
    const url = [this._baseUrl(), 'composite', 'sobjects', type].join('/');
    const fields =
      options.fields ||
      (await this.describe$(type)).fields.map((field) => field.name);
    return this.request({
      method: 'POST',
      url,
      body: JSON.stringify({ ids, fields }),
      headers: {
        ...(options.headers || {}),
        'content-type': 'application/json',
      },
    });
  }

  /**
   * Create records
   */
  create<
    N extends SObjectNames<S>,
    InputRecord extends SObjectInputRecord<S, N> = SObjectInputRecord<S, N>
  >(
    type: N,
    records: InputRecord[],
    options?: DmlOptions,
  ): Promise<SaveResult[]>;
  create<
    N extends SObjectNames<S>,
    InputRecord extends SObjectInputRecord<S, N> = SObjectInputRecord<S, N>
  >(type: N, record: InputRecord, options?: DmlOptions): Promise<SaveResult>;
  create<
    N extends SObjectNames<S>,
    InputRecord extends SObjectInputRecord<S, N> = SObjectInputRecord<S, N>
  >(
    type: N,
    records: InputRecord | InputRecord[],
    options?: DmlOptions,
  ): Promise<SaveResult | SaveResult[]>;
  /**
   * @param type
   * @param records
   * @param options
   */
  async create(
    type: string,
    records: Record | Record[],
    options: DmlOptions = {},
  ) {
    const ret = Array.isArray(records)
      ? // check the version whether SObject collection API is supported (42.0)
        this._ensureVersion(42)
        ? await this._createMany(type, records, options)
        : await this._createParallel(type, records, options)
      : await this._createSingle(type, records, options);
    return ret;
  }

  /** @private */
  async _createSingle(type: string, record: Record, options: DmlOptions) {
    const { Id, type: rtype, attributes, ...rec } = record;
    const sobjectType = type || (attributes && attributes.type) || rtype;
    if (!sobjectType) {
      throw new Error('No SObject Type defined in record');
    }
    const url = [this._baseUrl(), 'sobjects', sobjectType].join('/');
    return this.request({
      method: 'POST',
      url,
      body: JSON.stringify(rec),
      headers: {
        ...(options.headers || {}),
        'content-type': 'application/json',
      },
    });
  }

  /** @private */
  async _createParallel(type: string, records: Record[], options: DmlOptions) {
    if (records.length > this._maxRequest) {
      throw new Error('Exceeded max limit of concurrent call');
    }
    return Promise.all(
      records.map((record) =>
        this._createSingle(type, record, options).catch((err) => {
          // be aware that allOrNone in parallel mode will not revert the other successful requests
          // it only raises error when met at least one failed request.
          if (options.allOrNone || !err.errorCode) {
            throw err;
          }
          return toSaveResult(null, err);
        }),
      ),
    );
  }

  /** @private */
  async _createMany(
    type: string,
    records: Record[],
    options: DmlOptions,
  ): Promise<SaveResult[]> {
    if (records.length === 0) {
      return Promise.resolve([]);
    }
    if (records.length > MAX_DML_COUNT && options.allowRecursive) {
      return [
        ...(await this._createMany(
          type,
          records.slice(0, MAX_DML_COUNT),
          options,
        )),
        ...(await this._createMany(
          type,
          records.slice(MAX_DML_COUNT),
          options,
        )),
      ];
    }
    const _records = records.map((record) => {
      const { Id, type: rtype, attributes, ...rec } = record;
      const sobjectType = type || (attributes && attributes.type) || rtype;
      if (!sobjectType) {
        throw new Error('No SObject Type defined in record');
      }
      return { attributes: { type: sobjectType }, ...rec };
    });
    const url = [this._baseUrl(), 'composite', 'sobjects'].join('/');
    return this.request({
      method: 'POST',
      url,
      body: JSON.stringify({
        allOrNone: options.allOrNone || false,
        records: _records,
      }),
      headers: {
        ...(options.headers || {}),
        'content-type': 'application/json',
      },
    });
  }

  /**
   * Synonym of Connection#create()
   */
  insert = this.create;

  /**
   * Update records
   */
  update<
    N extends SObjectNames<S>,
    UpdateRecord extends SObjectUpdateRecord<S, N> = SObjectUpdateRecord<S, N>
  >(
    type: N,
    records: UpdateRecord[],
    options?: DmlOptions,
  ): Promise<SaveResult[]>;
  update<
    N extends SObjectNames<S>,
    UpdateRecord extends SObjectUpdateRecord<S, N> = SObjectUpdateRecord<S, N>
  >(type: N, record: UpdateRecord, options?: DmlOptions): Promise<SaveResult>;
  update<
    N extends SObjectNames<S>,
    UpdateRecord extends SObjectUpdateRecord<S, N> = SObjectUpdateRecord<S, N>
  >(
    type: N,
    records: UpdateRecord | UpdateRecord[],
    options?: DmlOptions,
  ): Promise<SaveResult | SaveResult[]>;
  /**
   * @param type
   * @param records
   * @param options
   */
  update<N extends SObjectNames<S>>(
    type: N,
    records: Record | Record[],
    options: DmlOptions = {},
  ): Promise<SaveResult | SaveResult[]> {
    return Array.isArray(records)
      ? // check the version whether SObject collection API is supported (42.0)
        this._ensureVersion(42)
        ? this._updateMany(type, records, options)
        : this._updateParallel(type, records, options)
      : this._updateSingle(type, records, options);
  }

  /** @private */
  async _updateSingle(
    type: string,
    record: Record,
    options: DmlOptions,
  ): Promise<SaveResult> {
    const { Id: id, type: rtype, attributes, ...rec } = record;
    if (!id) {
      throw new Error('Record id is not found in record.');
    }
    const sobjectType = type || (attributes && attributes.type) || rtype;
    if (!sobjectType) {
      throw new Error('No SObject Type defined in record');
    }
    const url = [this._baseUrl(), 'sobjects', sobjectType, id].join('/');
    return this.request(
      {
        method: 'PATCH',
        url,
        body: JSON.stringify(rec),
        headers: {
          ...(options.headers || {}),
          'content-type': 'application/json',
        },
      },
      {
        noContentResponse: { id, success: true, errors: [] },
      },
    );
  }

  /** @private */
  async _updateParallel(type: string, records: Record[], options: DmlOptions) {
    if (records.length > this._maxRequest) {
      throw new Error('Exceeded max limit of concurrent call');
    }
    return Promise.all(
      records.map((record) =>
        this._updateSingle(type, record, options).catch((err) => {
          // be aware that allOrNone in parallel mode will not revert the other successful requests
          // it only raises error when met at least one failed request.
          if (options.allOrNone || !err.errorCode) {
            throw err;
          }
          return toSaveResult(record.Id, err);
        }),
      ),
    );
  }

  /** @private */
  async _updateMany(
    type: string,
    records: Record[],
    options: DmlOptions,
  ): Promise<SaveResult[]> {
    if (records.length === 0) {
      return [];
    }
    if (records.length > MAX_DML_COUNT && options.allowRecursive) {
      return [
        ...(await this._updateMany(
          type,
          records.slice(0, MAX_DML_COUNT),
          options,
        )),
        ...(await this._updateMany(
          type,
          records.slice(MAX_DML_COUNT),
          options,
        )),
      ];
    }
    const _records = records.map((record) => {
      const { Id: id, type: rtype, attributes, ...rec } = record;
      if (!id) {
        throw new Error('Record id is not found in record.');
      }
      const sobjectType = type || (attributes && attributes.type) || rtype;
      if (!sobjectType) {
        throw new Error('No SObject Type defined in record');
      }
      return { id, attributes: { type: sobjectType }, ...rec };
    });
    const url = [this._baseUrl(), 'composite', 'sobjects'].join('/');
    return this.request({
      method: 'PATCH',
      url,
      body: JSON.stringify({
        allOrNone: options.allOrNone || false,
        records: _records,
      }),
      headers: {
        ...(options.headers || {}),
        'content-type': 'application/json',
      },
    });
  }

  /**
   * Upsert records
   */
  upsert<
    N extends SObjectNames<S>,
    InputRecord extends SObjectInputRecord<S, N> = SObjectInputRecord<S, N>,
    FieldNames extends SObjectFieldNames<S, N> = SObjectFieldNames<S, N>
  >(
    type: N,
    records: InputRecord[],
    extIdField: FieldNames,
    options?: DmlOptions,
  ): Promise<SaveResult[]>;
  upsert<
    N extends SObjectNames<S>,
    InputRecord extends SObjectInputRecord<S, N> = SObjectInputRecord<S, N>,
    FieldNames extends SObjectFieldNames<S, N> = SObjectFieldNames<S, N>
  >(
    type: N,
    record: InputRecord,
    extIdField: FieldNames,
    options?: DmlOptions,
  ): Promise<SaveResult>;
  upsert<
    N extends SObjectNames<S>,
    InputRecord extends SObjectInputRecord<S, N> = SObjectInputRecord<S, N>,
    FieldNames extends SObjectFieldNames<S, N> = SObjectFieldNames<S, N>
  >(
    type: N,
    records: InputRecord | InputRecord[],
    extIdField: FieldNames,
    options?: DmlOptions,
  ): Promise<SaveResult | SaveResult[]>;
  /**
   *
   * @param type
   * @param records
   * @param extIdField
   * @param options
   */
  async upsert(
    type: string,
    records: Record | Record[],
    extIdField: string,
    options: DmlOptions = {},
  ): Promise<SaveResult | SaveResult[]> {
    const isArray = Array.isArray(records);
    const _records = Array.isArray(records) ? records : [records];
    if (_records.length > this._maxRequest) {
      throw new Error('Exceeded max limit of concurrent call');
    }
    const results = await Promise.all(
      _records.map((record) => {
        const { [extIdField]: extId, type: rtype, attributes, ...rec } = record;
        const url = [this._baseUrl(), 'sobjects', type, extIdField, extId].join(
          '/',
        );
        return this.request(
          {
            method: 'PATCH',
            url,
            body: JSON.stringify(rec),
            headers: {
              ...(options.headers || {}),
              'content-type': 'application/json',
            },
          },
          {
            noContentResponse: { success: true, errors: [] },
          },
        ).catch((err) => {
          // Be aware that `allOrNone` option in upsert method
          // will not revert the other successful requests.
          // It only raises error when met at least one failed request.
          if (!isArray || options.allOrNone || !err.errorCode) {
            throw err;
          }
          return toSaveResult(null, err);
        });
      }),
    );
    return isArray ? results : results[0];
  }

  /**
   * Delete records
   */
  destroy<N extends SObjectNames<S>>(
    type: N,
    ids: string[],
    options?: DmlOptions,
  ): Promise<SaveResult[]>;
  destroy<N extends SObjectNames<S>>(
    type: N,
    id: string,
    options?: DmlOptions,
  ): Promise<SaveResult>;
  destroy<N extends SObjectNames<S>>(
    type: N,
    ids: string | string[],
    options?: DmlOptions,
  ): Promise<SaveResult | SaveResult[]>;
  /**
   * @param type
   * @param ids
   * @param options
   */
  async destroy(
    type: string,
    ids: string | string[],
    options: DmlOptions = {},
  ): Promise<SaveResult | SaveResult[]> {
    return Array.isArray(ids)
      ? // check the version whether SObject collection API is supported (42.0)
        this._ensureVersion(42)
        ? this._destroyMany(type, ids, options)
        : this._destroyParallel(type, ids, options)
      : this._destroySingle(type, ids, options);
  }

  /** @private */
  async _destroySingle(
    type: string,
    id: string,
    options: DmlOptions,
  ): Promise<SaveResult> {
    const url = [this._baseUrl(), 'sobjects', type, id].join('/');
    return this.request(
      {
        method: 'DELETE',
        url,
        headers: options.headers || {},
      },
      {
        noContentResponse: { id, success: true, errors: [] },
      },
    );
  }

  /** @private */
  async _destroyParallel(type: string, ids: string[], options: DmlOptions) {
    if (ids.length > this._maxRequest) {
      throw new Error('Exceeded max limit of concurrent call');
    }
    return Promise.all(
      ids.map((id) =>
        this._destroySingle(type, id, options).catch((err) => {
          // Be aware that `allOrNone` option in parallel mode
          // will not revert the other successful requests.
          // It only raises error when met at least one failed request.
          if (options.allOrNone || !err.errorCode) {
            throw err;
          }
          return toSaveResult(id, err);
        }),
      ),
    );
  }

  /** @private */
  async _destroyMany(
    type: string,
    ids: string[],
    options: DmlOptions,
  ): Promise<SaveResult[]> {
    if (ids.length === 0) {
      return [];
    }
    if (ids.length > MAX_DML_COUNT && options.allowRecursive) {
      return [
        ...(await this._destroyMany(
          type,
          ids.slice(0, MAX_DML_COUNT),
          options,
        )),
        ...(await this._destroyMany(type, ids.slice(MAX_DML_COUNT), options)),
      ];
    }
    let url =
      [this._baseUrl(), 'composite', 'sobjects?ids='].join('/') + ids.join(',');
    if (options.allOrNone) {
      url += '&allOrNone=true';
    }
    return this.request({
      method: 'DELETE',
      url,
      headers: options.headers || {},
    });
  }

  /**
   * Synonym of Connection#destroy()
   */
  delete = this.destroy;

  /**
   * Synonym of Connection#destroy()
   */
  del = this.destroy;

  /**
   * Describe SObject metadata
   */
  async describe(type: string): Promise<DescribeSObjectResult> {
    const url = [this._baseUrl(), 'sobjects', type, 'describe'].join('/');
    const body = await this.request(url);
    return body as DescribeSObjectResult;
  }

  /**
   * Describe global SObjects
   */
  async describeGlobal() {
    const url = `${this._baseUrl()}/sobjects`;
    const body = await this.request(url);
    return body as DescribeGlobalResult;
  }

  /**
   * Get SObject instance
   */
  sobject<N extends SObjectNames<S>>(type: N): SObject<S, N>;
  sobject<N extends SObjectNames<S>>(type: string): SObject<S, N>;
  sobject<N extends SObjectNames<S>>(type: N | string): SObject<S, N> {
    const so =
      (this.sobjects[type as N] as SObject<S, N> | undefined) ||
      new SObject(this, type as N);
    this.sobjects[type as N] = so;
    return so;
  }

  /**
   * Get identity information of current user
   */
  async identity(options: { headers?: { [name: string]: string } } = {}) {
    let url = this.userInfo && this.userInfo.url;
    if (!url) {
      const res = await this.request({
        method: 'GET',
        url: this._baseUrl(),
        headers: options.headers,
      });
      url = res.identity as string;
    }
    url += '?format=json';
    if (this.accessToken) {
      url += `&oauth_token=${encodeURIComponent(this.accessToken)}`;
    }
    const res = await this.request({ method: 'GET', url });
    this.userInfo = {
      id: res.user_id,
      organizationId: res.organization_id,
      url: res.id,
    };
    return res;
  }

  /**
   * List recently viewed records
   */
  async recent(type?: string | number, limit?: number) {
    /* eslint-disable no-param-reassign */
    if (typeof type === 'number') {
      limit = type;
      type = undefined;
    }
    let url;
    if (type) {
      url = [this._baseUrl(), 'sobjects', type].join('/');
      const { recentItems } = await this.request(url);
      return limit ? recentItems.slice(0, limit) : recentItems;
    }
    url = `${this._baseUrl()}/recent`;
    if (limit) {
      url += `?limit=${limit}`;
    }
    return this.request(url);
  }

  /**
   * Retrieve updated records
   */
  async updated(
    type: string,
    start: string | Date,
    end: string | Date,
  ): Promise<UpdatedResult> {
    /* eslint-disable no-param-reassign */
    let url = [this._baseUrl(), 'sobjects', type, 'updated'].join('/');
    if (typeof start === 'string') {
      start = new Date(start);
    }
    start = formatDate(start);
    url += `?start=${encodeURIComponent(start)}`;
    if (typeof end === 'string') {
      end = new Date(end);
    }
    end = formatDate(end);
    url += `&end=${encodeURIComponent(end)}`;
    const body = await this.request(url);
    return body as UpdatedResult;
  }

  /**
   * Retrieve deleted records
   */
  async deleted(
    type: string,
    start: string | Date,
    end: string | Date,
  ): Promise<DeletedResult> {
    /* eslint-disable no-param-reassign */
    let url = [this._baseUrl(), 'sobjects', type, 'deleted'].join('/');
    if (typeof start === 'string') {
      start = new Date(start);
    }
    start = formatDate(start);
    url += `?start=${encodeURIComponent(start)}`;

    if (typeof end === 'string') {
      end = new Date(end);
    }
    end = formatDate(end);
    url += `&end=${encodeURIComponent(end)}`;
    const body = await this.request(url);
    return body as DeletedResult;
  }

  /**
   * Returns a list of all tabs
   */
  async tabs(): Promise<DescribeTab[]> {
    const url = [this._baseUrl(), 'tabs'].join('/');
    const body = await this.request(url);
    return body as DescribeTab[];
  }

  /**
   * Returns curren system limit in the organization
   */
  async limits(): Promise<OrganizationLimitsInfo> {
    const url = [this._baseUrl(), 'limits'].join('/');
    const body = await this.request(url);
    return body as OrganizationLimitsInfo;
  }

  /**
   * Returns a theme info
   */
  async theme(): Promise<DescribeTheme> {
    const url = [this._baseUrl(), 'theme'].join('/');
    const body = await this.request(url);
    return body as DescribeTheme;
  }

  /**
   * Returns all registered global quick actions
   */
  async quickActions(): Promise<DescribeQuickActionResult[]> {
    const body = await this.request('/quickActions');
    return body as DescribeQuickActionResult[];
  }

  /**
   * Get reference for specified global quick aciton
   */
  quickAction(actionName: string): QuickAction<S> {
    return new QuickAction(this, `/quickActions/${actionName}`);
  }
}
