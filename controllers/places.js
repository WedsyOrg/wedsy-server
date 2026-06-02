const PlacesService = require("../services/PlacesService");

const Autocomplete = async (req, res) => {
  try {
    const results = await PlacesService.autocomplete(
      req.query.input,
      req.query.country
    );
    return res.status(200).json(results);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

const Details = async (req, res) => {
  try {
    const place = await PlacesService.details(req.query.placeId);
    return res.status(200).json(place);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = { Autocomplete, Details };
