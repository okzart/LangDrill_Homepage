// Wraps an async Express route handler so a rejected promise is forwarded
// to next(err) automatically. Express 4 (what this project uses) does NOT
// do this on its own - an unhandled rejection inside an async handler
// would otherwise just hang the request instead of reaching errorHandler.
//
// Stateless wrapper, so a static method rather than an instance. Same file
// as the other services in this family.
class AsyncHandler {
  static wrap(fn) {
    return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  }
}

module.exports = AsyncHandler;
