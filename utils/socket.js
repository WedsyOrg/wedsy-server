let io = null;
const set = (instance) => { io = instance; };
const get = () => io;
module.exports = { set, get };
