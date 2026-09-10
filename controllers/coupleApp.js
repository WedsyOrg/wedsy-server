// COUPLE APP — the couple-facing controllers (§ 06.2).
//
// Layering follows this repo's own: the route mounts the gates, the controller
// does nothing but call a service and answer, and the service owns the reads
// and the arithmetic. Every handler is wrapped so no couple-app route can throw
// out of an async callback into an unhandled rejection (repo rule 4).
//
// Auth and permissions are NOT here. middlewares/coupleAuth resolves the caller
// and refuses the wedding; RequireSection refuses the section (§ 06.4). A
// controller in this file can assume `req.couple` is a person entitled to what
// the route mounted.
const CoupleWeddingService = require("../services/CoupleWeddingService");

const respond = (res, error, fallback) => {
  const status = error && error.status ? error.status : 500;
  if (status === 500) console.error("[coupleApp]", error);
  res.status(status).send({
    error: status === 500 ? "server_error" : error.code || "error",
    message: status === 500 ? fallback : error.message,
  });
};

// try/catch, once, for every route in this file.
const wrap = (fn, fallback) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    respond(res, error, fallback);
  }
};

/** GET /wedding/:id — the wedding, its functions and its team. */
const GetWedding = wrap(async (req, res) => {
  res.status(200).send(await CoupleWeddingService.getWedding(req.couple));
}, "We could not open your wedding — please retry.");

/** GET /wedding/:id/home — { decisions[], activity[], stats }. */
const GetHome = wrap(async (req, res) => {
  res.status(200).send(await CoupleWeddingService.getHome(req.couple));
}, "We could not load your home screen — please retry.");

module.exports = { GetWedding, GetHome };
