const Admin = require("../models/Admin");
const Community = require("../models/Community");
const CommunityReply = require("../models/CommunityReply");
const User = require("../models/User");
const Vendor = require("../models/Vendor");

const removeByIdAndRole = (array, id, role) => {
  const index = array.findIndex(
    (item) => item.id.equals(id) && item.role === role
  );
  if (index > -1) array.splice(index, 1);
};

const restructureCommunity = async (item, user_id, role) => {
  let temp = item.toObject();
  let name = "";
  let likes = temp?.likes?.length || 0;
  let dislikes = temp?.dislikes?.length || 0;
  const liked = temp.likes.some(
    (like) => like.id.equals(user_id) && like.role === role
  );
  const disliked = temp.dislikes.some(
    (dislike) => dislike.id.equals(user_id) && dislike.role === role
  );
  if (item.author.role === "admin") {
    const admin = await Admin.findById(item.author.id);
    name = admin?.name || "";
  } else if (item.author.role === "vendor") {
    const vendor = await Vendor.findById(item.author.id);
    name = vendor?.name || "";
  } else if (item.author.role === "user") {
    const user = await User.findById(item.author.id);
    name = user?.name || "";
  }
  temp.author = {
    ...temp.author,
    name,
  };
  temp = { ...temp, likes, dislikes, liked, disliked };
  return temp;
};

const CreateNew = (req, res) => {
  const { user_id, isVendor, isAdmin } = req.auth;
  const { title, category, body, anonymous } = req.body;
  if (!title || !category || !body) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    new Community({
      title,
      category,
      body,
      author: {
        anonymous,
        id: user_id,
        role: isAdmin ? "admin" : isVendor ? "vendor" : "user",
      },
    })
      .save()
      .then((result) => {
        res.status(201).send({ message: "success", id: result._id });
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  }
};

const GetAll = (req, res) => {
  const { user_id, isVendor, isAdmin, user } = req.auth;
  const role = isAdmin ? "admin" : isVendor ? "vendor" : "user";
  Community.find(isVendor ? { category: user?.category } : {})
    .then((result) => {
      Promise.all(
        result.map(async (item) => {
          let temp = item.toObject();
          let name = "";
          let likes = temp?.likes?.length || 0;
          let dislikes = temp?.dislikes?.length || 0;
          const liked = temp.likes.some(
            (like) => like.id.equals(user_id) && like.role === role
          );
          const disliked = temp.dislikes.some(
            (dislike) => dislike.id.equals(user_id) && dislike.role === role
          );
          if (item.author.role === "admin") {
            const admin = await Admin.findById(item.author.id);
            name = admin?.name || "";
          } else if (item.author.role === "vendor") {
            const vendor = await Vendor.findById(item.author.id);
            name = vendor?.name || "";
          } else if (item.author.role === "user") {
            const user = await User.findById(item.author.id);
            name = user?.name || "";
          }
          temp.author = {
            ...temp.author,
            name,
          };
          let tempReplies = await CommunityReply.find({
            community: item._id,
          }).then((replies) => {
            return new Promise((resolve, reject) =>
              Promise.all(
                replies.map(async (reply) => {
                  let tempItem = reply.toObject();
                  let name = "";
                  if (reply.author.role === "admin") {
                    const admin = await Admin.findById(reply.author.id);
                    name = admin?.name || "";
                  } else if (reply.author.role === "vendor") {
                    const vendor = await Vendor.findById(reply.author.id);
                    name = vendor?.name || "";
                  } else if (reply.author.role === "user") {
                    const user = await User.findById(reply.author.id);
                    name = user?.name || "";
                  }
                  tempItem.author = {
                    ...tempItem.author,
                    name,
                  };
                  return tempItem;
                })
              ).then((updatedReplies) => resolve(updatedReplies))
            );
          });
          temp = {
            ...temp,
            likes,
            dislikes,
            liked,
            disliked,
            replies: tempReplies,
          };
          return temp;
        })
      ).then((list) => res.send(list));
    })
    .catch((error) => {
      res.status(400).send({
        message: "error",
        error,
      });
    });
};

const Get = (req, res) => {
  const { _id } = req.params;
  const { user_id, isVendor, isAdmin } = req.auth;
  const role = isAdmin ? "admin" : isVendor ? "vendor" : "user";
  Community.findOne({ _id })
    .then(async (result) => {
      if (!result) {
        res.status(404).send();
      } else {
        let tempCommunity = await restructureCommunity(result, user_id, role);
        CommunityReply.find({ community: _id }).then((replies) => {
          Promise.all(
            replies.map(async (reply) => {
              let temp = reply.toObject();
              let name = "";
              if (reply.author.role === "admin") {
                const admin = await Admin.findById(reply.author.id);
                name = admin?.name || "";
              } else if (reply.author.role === "vendor") {
                const vendor = await Vendor.findById(reply.author.id);
                name = vendor?.name || "";
              } else if (reply.author.role === "user") {
                const user = await User.findById(reply.author.id);
                name = user?.name || "";
              }
              temp.author = {
                ...temp.author,
                name,
              };
              return temp;
            })
          ).then((updatedReplies) =>
            res.send({ ...tempCommunity, replies: updatedReplies })
          );
        });
      }
    })
    .catch((error) => {
      res.status(400).send({
        message: "error",
        error,
      });
    });
};

const Delete = (req, res) => {
  const { _id } = req.params;
  Community.findOneAndDelete({ _id })
    .then((result) => {
      if (result) {
        res.status(200).send({ message: "success" });
      } else {
        res.status(404).send({ message: "not found" });
      }
    })
    .catch((error) => {
      res.status(400).send({ message: "error", error });
    });
};

const DeleteReply = (req, res) => {
  const { _id, rid } = req.params;
  CommunityReply.findOneAndDelete({ _id: rid, community: _id })
    .then((result) => {
      if (result) {
        res.status(200).send({ message: "success" });
      } else {
        res.status(404).send({ message: "not found" });
      }
    })
    .catch((error) => {
      res.status(400).send({ message: "error", error });
    });
};

const AddLike = async (req, res) => {
  const { _id } = req.params;
  const { user_id, isVendor, isAdmin } = req.auth;
  const role = isAdmin ? "admin" : isVendor ? "vendor" : "user";
  const community = await Community.findById({ _id });
  if (!community) {
    return res.status(404).json({ error: "Community not found" });
  }
  removeByIdAndRole(community.dislikes, user_id, role);
  const alreadyLiked = community.likes.some(
    (like) => like.id.equals(user_id) && like.role === role
  );
  if (!alreadyLiked) {
    community.likes.push({ id: user_id, role });
  }
  await community.save();
  let temp = await restructureCommunity(community, user_id, role);
  res.status(200).json({ message: "success", community: temp });
};

const AddDisLike = async (req, res) => {
  const { _id } = req.params;
  const { user_id, isVendor, isAdmin } = req.auth;
  const role = isAdmin ? "admin" : isVendor ? "vendor" : "user";
  const community = await Community.findById(_id);
  if (!community) {
    return res.status(404).json({ error: "Community not found" });
  }
  removeByIdAndRole(community.likes, user_id, role);
  const alreadyDisliked = community.dislikes.some(
    (dislike) => dislike.id.equals(user_id) && dislike.role === role
  );
  if (!alreadyDisliked) {
    community.dislikes.push({ id: user_id, role });
  }
  await community.save();
  let temp = await restructureCommunity(community, user_id, role);
  res.status(200).json({ message: "success", community: temp });
};

const RemoveLike = async (req, res) => {
  const { _id } = req.params;
  const { user_id, isVendor, isAdmin } = req.auth;
  const role = isAdmin ? "admin" : isVendor ? "vendor" : "user";
  const community = await Community.findById(_id);
  if (!community) {
    return res.status(404).json({ error: "Community not found" });
  }
  removeByIdAndRole(community.likes, user_id, role);
  removeByIdAndRole(community.dislikes, user_id, role);
  await community.save();
  let temp = await restructureCommunity(community, user_id, role);
  res.status(200).json({ message: "success", community: temp });
};

const RemoveDisLike = async (req, res) => {
  const { _id } = req.params;
  const { user_id, isVendor, isAdmin } = req.auth;
  const role = isAdmin ? "admin" : isVendor ? "vendor" : "user";
  const community = await Community.findById(_id);
  if (!community) {
    return res.status(404).json({ error: "Community not found" });
  }
  removeByIdAndRole(community.likes, user_id, role);
  removeByIdAndRole(community.dislikes, user_id, role);
  await community.save();
  let temp = await restructureCommunity(community, user_id, role);
  res.status(200).json({ message: "success", community: temp });
};

const AddReply = (req, res) => {
  try {
    const { user_id, isVendor, isAdmin } = req.auth;
    const { reply } = req.body;
    const { _id } = req.params;
    if (!reply) {
      res.status(400).send({ message: "Incomplete Data" });
    } else {
      new CommunityReply({
        community: _id,
        reply,
        author: {
          anonymous: false,
          id: user_id,
          role: isAdmin ? "admin" : isVendor ? "vendor" : "user",
        },
      })
        .save()
        .then((result) => {
          res.status(200).send({ message: "success" });
        })
        .catch((error) => {
          res.status(400).send({ message: "error", error });
        });
    }
  } catch (error) {
    console.log(error);
  }
};

module.exports = {
  CreateNew,
  GetAll,
  Get,
  Delete,
  DeleteReply,
  AddLike,
  AddDisLike,
  RemoveLike,
  RemoveDisLike,
  AddReply,
};
