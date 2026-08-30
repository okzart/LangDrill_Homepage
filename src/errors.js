// Thrown by services/gatewayClient.js when the API Gateway (or a service
// behind it) answers with a non-2xx status. Carries that status straight
// through so middleware/errorHandler.js can decide how to react (401 ->
// the caller's session is stale, clear it and send them back to /login;
// anything else -> show the message on an error page) without this
// service re-deriving what the status meant.
class GatewayError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

module.exports = { GatewayError };
