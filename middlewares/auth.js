const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Admin = require("../models/Admin");
const Vendor = require("../models/Vendor");

function CheckToken(req, res, next) {
  if (!req.headers.authorization) {
    req.auth = {
      user_id: "",
      user: {},
      isAdmin: false,
      isVendor: false,
    };
    next();
    return;
  }
  const token = req.headers.authorization.split(" ")[1];
  if (!token || token === "null") {
    req.auth = {
      user_id: "",
      user: {},
      isAdmin: false,
      isVendor: false,
    };
    next();
    return;
  }
  jwt.verify(token, process.env.JWT_SECRET, async function (err, result) {
    if (err) {
      req.auth = {
        user_id: "",
        user: {},
        isAdmin: false,
        isVendor: false,
      };
      next();
      return;
    } else {
      const { _id, isAdmin, isVendor } = result;
      if (_id && isAdmin) {
        Admin.findById({ _id })
          .then((user) => {
            if (!user) {
              req.auth = {
                user_id: "",
                user: {},
                isAdmin: false,
                isVendor: false,
              };
              next();
              return;
            } else {
              req.auth = {
                user_id: _id,
                user,
                roles: user.roles,
                isAdmin: true,
                isVendor: false,
              };
              next();
            }
          })
          .catch((error) => {
            req.auth = {
              user_id: "",
              user: {},
              isAdmin: false,
            };
            next();
            return;
          });
      } else if (_id && isVendor) {
        // Vendor.findById({ _id })
        //   .then((user) => {
        //     if (!user) {
        //       req.auth = {
        //         user_id: "",
        //         user: {},
        //         isAdmin: false,
        //         isVendor: false,
        //       };
        //       next();
        //       return;
        //     } else {
        //       req.auth = {
        //         user_id: _id,
        //         user,
        //         isAdmin: false,
        //         isVendor: true,
        //       };
        //       next();
        //     }
        //   })
        //   .catch((error) => {
        //     req.auth = {
        //       user_id: "",
        //       user: {},
        //       isAdmin: false,
        //       isVendor: false,
        //     };
        //     next();
        //     return;
        //   });
        try {
          const vendor = await Vendor.findById(_id);
          if (!vendor) {
            res.status(401).send({ message: "invalid user" });
          } else {
            // Update lastActive field
            vendor.lastActive = Date.now();
            await vendor.save(); // Save updated vendor

            req.auth = {
              user_id: _id,
              user: vendor,
              isAdmin: false,
              isVendor: true,
            };
            next();
          }
        } catch (error) {
          res.status(400).send({ message: "error", error });
        }
      } else if (_id) {
        User.findById({ _id })
          .then((user) => {
            if (!user) {
              req.auth = {
                user_id: "",
                user: {},
                isAdmin: false,
                isVendor: false,
              };
              next();
              return;
            } else {
              req.auth = {
                user_id: _id,
                user,
                isAdmin: false,
                isVendor: false,
              };
              next();
            }
          })
          .catch((error) => {
            req.auth = {
              user_id: "",
              user: {},
              isAdmin: false,
              isVendor: false,
            };
            next();
            return;
          });
      } else {
        req.auth = {
          user_id: "",
          user: {},
          isAdmin: false,
          isVendor: false,
        };
        next();
        return;
      }
    }
  });
}

function CheckLogin(req, res, next) {
  console.log("CheckLogin middleware called for:", req.method, req.originalUrl);
  console.log("CheckLogin auth header:", req.headers.authorization ? "Present" : "Missing");
  
  if (!req.headers.authorization) {
    console.log("CheckLogin: No auth header, sending 400");
    res.status(400).send({ message: "No Auth Token" });
    return;
  }
  const token = req.headers.authorization.split(" ")[1];
  if (!token) {
    console.log("CheckLogin: No token in auth header, sending 400");
    res.status(400).send({ message: "No Auth Token" });
    return;
  }
  console.log("CheckLogin: Token present, verifying...");
  jwt.verify(token, process.env.JWT_SECRET, async function (err, result) {
    if (err) {
      res.status(400).send({ message: "error", error: err });
    } else {
      const { _id, isAdmin, isVendor } = result;
      if (_id && isAdmin) {
        Admin.findById({ _id })
          .then((user) => {
            if (!user) {
              res.status(401).send({ message: "invalid user" });
            } else {
              req.auth = {
                user_id: _id,
                user,
                roles: user.roles,
                isAdmin: true,
                isVendor: false,
              };
              next();
            }
          })
          .catch((error) => {
            res.status(400).send({ message: "error", error });
          });
      } else if (_id && isVendor) {
        // Vendor.findById({ _id })
        //   .then((user) => {
        //     if (!user) {
        //       res.status(401).send({ message: "invalid user" });
        //     } else {
        //       req.auth = {
        //         user_id: _id,
        //         user,
        //         isAdmin: false,
        //         isVendor: true,
        //       };
        //       next();
        //     }
        //   })
        //   .catch((error) => {
        //     res.status(400).send({ message: "error", error });
        //   });
        try {
          const vendor = await Vendor.findById(_id);
          if (!vendor) {
            res.status(401).send({ message: "invalid user" });
          } else {
            // Update lastActive field
            vendor.lastActive = Date.now();
            await vendor.save(); // Save updated vendor

            req.auth = {
              user_id: _id,
              user: vendor,
              isAdmin: false,
              isVendor: true,
            };
            next();
          }
        } catch (error) {
          res.status(400).send({ message: "error", error });
        }
      } else if (_id) {
        User.findById({ _id })
          .then((user) => {
            if (!user) {
              res.status(401).send({ message: "invalid user" });
            } else {
              req.auth = {
                user_id: _id,
                user,
                isAdmin: false,
                isVendor: false,
              };
              next();
            }
          })
          .catch((error) => {
            res.status(400).send({ message: "error", error });
          });
      } else {
        res.status(400).send({ message: "unknown error" });
      }
    }
  });
}

function CheckAdminLogin(req, res, next) {
  if (!req.headers.authorization) {
    res.status(400).send({ message: "No Auth Token" });
    return;
  }
  const token = req.headers.authorization.split(" ")[1];
  if (!token) {
    res.status(400).send({ message: "No Auth Token" });
    return;
  }
  jwt.verify(token, process.env.JWT_SECRET, function (err, result) {
    if (err) {
      res.status(400).send({ message: "error", error: err });
    } else {
      const { _id, isAdmin } = result;
      if (_id && isAdmin) {
        Admin.findById({ _id })
          .then((user) => {
            if (!user) {
              res.status(401).send({ message: "invalid user" });
            } else {
              req.auth = {
                user_id: _id,
                user,
                roles: user.roles,
                isAdmin: true,
                isVendor: false,
              };
              next();
            }
          })
          .catch((error) => {
            res.status(400).send({ message: "error", error });
          });
      } else {
        res.status(400).send({ message: "unknown error" });
      }
    }
  });
}

function CheckVendorLogin(req, res, next) {
  if (!req.headers.authorization) {
    res.status(400).send({ message: "No Auth Token" });
    return;
  }
  const token = req.headers.authorization.split(" ")[1];
  if (!token) {
    res.status(400).send({ message: "No Auth Token" });
    return;
  }
  jwt.verify(token, process.env.JWT_SECRET, async function (err, result) {
    if (err) {
      res.status(400).send({ message: "error", error: err });
    } else {
      const { _id, isVendor } = result;
      if (_id && isVendor) {
        // Vendor.findById({ _id })
        //   .then((user) => {
        //     if (!user) {
        //       res.status(401).send({ message: "invalid user" });
        //     } else {
        //       req.auth = {
        //         user_id: _id,
        //         user,
        //         isAdmin: false,
        //         isVendor: true,
        //       };
        //       next();
        //     }
        //   })
        //   .catch((error) => {
        //     res.status(400).send({ message: "error", error });
        //   });
        try {
          const vendor = await Vendor.findById(_id);
          if (!vendor) {
            res.status(401).send({ message: "invalid user" });
          } else {
            // Update lastActive field
            vendor.lastActive = Date.now();
            await vendor.save(); // Save updated vendor

            req.auth = {
              user_id: _id,
              user: vendor,
              isAdmin: false,
              isVendor: true,
            };
            next();
          }
        } catch (error) {
          res.status(400).send({ message: "error", error });
        }
      } else {
        res.status(400).send({ message: "unknown error" });
      }
    }
  });
}

module.exports = { CheckLogin, CheckAdminLogin, CheckToken, CheckVendorLogin };
