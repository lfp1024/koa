
'use strict';

/**
 * Module dependencies.
 */

const isGeneratorFunction = require('is-generator-function');
const debug = require('debug')('koa:application');
// 在 request 或  response 阶段的末尾添加钩子函数
const onFinished = require('on-finished');
const response = require('./response');
const compose = require('koa-compose');
const context = require('./context');
const request = require('./request');
const statuses = require('statuses');
const Emitter = require('events');
const util = require('util');
const Stream = require('stream');
const http = require('http');
// 将一个对象中需要的部分属性提取出来，返回一个新的对象
const only = require('only');
const convert = require('koa-convert');
const deprecate = require('depd')('koa');
const { HttpError } = require('http-errors');

/**
 * Expose `Application` class.
 * Inherits from `Emitter.prototype`.
 */

module.exports = class Application extends Emitter {
  /**
   * Initialize a new `Application`.
   *
   * @api public
   */

  /**
    *
    * @param {object} [options] Application options
    * @param {string} [options.env='development'] Environment
    * @param {string[]} [options.keys] Signed cookie keys
    * @param {boolean} [options.proxy] Trust proxy headers
    * @param {number} [options.subdomainOffset] Subdomain offset
    * @param {boolean} [options.proxyIpHeader] proxy ip header, default to X-Forwarded-For
    * @param {boolean} [options.maxIpsCount] max ips read from proxy ip header, default to 0 (means infinity)
    *
    */

  constructor(options) {
    super();
    options = options || {};

    // 如果没有传递 options， 则options.proxy = undefined，此时值为 false
    this.proxy = options.proxy || false;
    this.subdomainOffset = options.subdomainOffset || 2;
    // proxyIpHeader = false, 值为 'X-Forwarded-For'
    // proxyIpHeader = true，值为 true
    this.proxyIpHeader = options.proxyIpHeader || 'X-Forwarded-For';
    this.maxIpsCount = options.maxIpsCount || 0;
    // 设定的环境变量 NODE_ENV
    this.env = options.env || process.env.NODE_ENV || 'development';
    // keys 没有默认值，可能为undefined
    if (options.keys) this.keys = options.keys;

    // 中间件
    this.middleware = [];

    // 每个 app 都有三个实例
    // 创建新对象，继承现有对象的方法和属性
    this.context = Object.create(context);
    this.request = Object.create(request);
    this.response = Object.create(response);

    // util.inspect.custom support for node 6+
    /* istanbul ignore else */
    // 产生一个 symbol 值 ？
    if (util.inspect.custom) {
      this[util.inspect.custom] = this.inspect;
    };
  }

  /**
   * 简写，调用 listen 方法即创建一个 http 服务器并监听端口
   * Shorthand for:
   *
   *    http.createServer(app.callback()).listen(...)
   *
   * @param {Mixed} ...
   * @return {Server}
   * @api public
   */

  listen(...args) {
    debug('listen...');
    const server = http.createServer(this.callback());
    return server.listen(...args);
  }

  /**
   * Return JSON representation.
   * We only bother showing settings.
   *
   * @return {Object}
   * @api public
   */

  toJSON() {
    return only(this, [
      'subdomainOffset',
      'proxy',
      'env'
    ]);
  }

  /**
   * Inspect implementation.
   *
   * @return {Object}
   * @api public
   */

  inspect() {
    return this.toJSON();
  }

  /**
   * 注册中间件，给 middleware 数组中添加 中间件函数
   * Use the given middleware `fn`.
   *
   * Old-style middleware will be converted.
   *
   * @param {Function} fn
   * @return {Application} self
   * @api public
   */

  use(fn) {
    if (typeof fn !== 'function') throw new TypeError('middleware must be a function!');
    if (isGeneratorFunction(fn)) {
      deprecate('Support for generators will be removed in v3. ' +
        'See the documentation for examples of how to convert old middleware ' +
        'https://github.com/koajs/koa/blob/master/docs/migration.md');
      fn = convert(fn);
    }
    debug('use %s', fn._name || fn.name || '-');
    this.middleware.push(fn);
    return this;
  }

  /**
   * Return a request handler callback
   * for node's native http server.
   *
   * @return {Function}
   * @api public
   */

  callback() {
    // 利用 compose 函数，将中间件函数连接起来，通过 next 参数依次调用执行，实现洋葱模型
    const fn = compose(this.middleware);

    if (!this.listenerCount('error')) this.on('error', this.onerror);

    // 收到请求的时候，执行该回调函数
    const handleRequest = (req, res) => {
      // 箭头函数，this -> application
      const ctx = this.createContext(req, res);
      return this.handleRequest(ctx, fn);
    };

    return handleRequest;
  }

  /**
   * Handle request in callback.
   *
   * @api private
   */

  handleRequest(ctx, fnMiddleware) {
    const res = ctx.res;
    res.statusCode = 404;
    const onerror = err => ctx.onerror(err);
    const handleResponse = () => respond(ctx);
    // Execute a callback when a request closes, finishes, or errors
    onFinished(res, onerror);
    // 中间件都会传入一个本次请求生成的 ctx 对象，所有中间件都执行完之后，通过 handleResponse 处理响应
    return fnMiddleware(ctx).then(handleResponse).catch(onerror);
  }

  /**
   * 每个 app 都有 context request response 三个实例
   * 每个 请求 都会基于这三个实例去创建自己的实例
   * 将 node 原生的 req res 及 this 挂载到每个请求新创建的实例上，以及为了方便访问的一些挂载
   * 返回本次请求创建的context，作为所有中间件的第一个参数 ctx
   * Initialize a new context.
   *
   * @api private
   */

  createContext(req, res) {
    // 继承 context.js 中实现的属性和方法
    const context = Object.create(this.context);
    // 继承 request.js 中实现的属性和方法
    const request = context.request = Object.create(this.request);
    // 继承 response.js 中实现的属性和方法
    const response = context.response = Object.create(this.response);

    // 互相挂载，互相访问
    context.app = request.app = response.app = this;
    context.req = request.req = response.req = req;
    context.res = request.res = response.res = res;

    request.ctx = response.ctx = context;

    request.response = response;
    response.request = request;

    context.originalUrl = request.originalUrl = req.url;

    context.state = {};

    return context;
  }

  /**
   * Default error handler.
   *
   * @param {Error} err
   * @api private
   */

  onerror(err) {
    // When dealing with cross-globals a normal `instanceof` check doesn't work properly.
    // See https://github.com/koajs/koa/issues/1466
    // We can probably remove it once jest fixes https://github.com/facebook/jest/issues/2549.
    const isNativeError =
      Object.prototype.toString.call(err) === '[object Error]' ||
      err instanceof Error;
    if (!isNativeError) throw new TypeError(util.format('non-error thrown: %j', err));

    if (404 === err.status || err.expose) return;
    if (this.silent) return;

    const msg = err.stack || err.toString();
    console.error(`\n${msg.replace(/^/gm, '  ')}\n`);
  }
};

/**
 * 当前 application 类的私有方法
 * 将 ctx 上挂载的 body 通过 res.end 返回响应
 * Response helper.
 */

function respond(ctx) {
  // allow bypassing koa
  if (false === ctx.respond) return;

  if (!ctx.writable) return;

  const res = ctx.res;
  let body = ctx.body;
  const code = ctx.status;

  // ignore body
  if (statuses.empty[code]) {
    // strip headers
    ctx.body = null;
    return res.end();
  }

  if ('HEAD' === ctx.method) {
    if (!res.headersSent && !ctx.response.has('Content-Length')) {
      const { length } = ctx.response;
      if (Number.isInteger(length)) ctx.length = length;
    }
    return res.end();
  }

  // status body
  if (null == body) {
    if (ctx.response._explicitNullBody) {
      ctx.response.remove('Content-Type');
      ctx.response.remove('Transfer-Encoding');
      return res.end();
    }
    if (ctx.req.httpVersionMajor >= 2) {
      body = String(code);
    } else {
      body = ctx.message || String(code);
    }
    if (!res.headersSent) {
      ctx.type = 'text';
      ctx.length = Buffer.byteLength(body);
    }
    return res.end(body);
  }

  // responses
  if (Buffer.isBuffer(body)) return res.end(body);
  if ('string' === typeof body) return res.end(body);
  if (body instanceof Stream) return body.pipe(res);

  // body: json
  body = JSON.stringify(body);
  if (!res.headersSent) {
    ctx.length = Buffer.byteLength(body);
  }
  res.end(body);
}

/**
 * Make HttpError available to consumers of the library so that consumers don't
 * have a direct dependency upon `http-errors`
 */

module.exports.HttpError = HttpError;
