const CallCockpitService = require("../services/CallCockpitService");

// POST /enquiry/:_id/call-log
const LogCall = async (req, res) => {
  try {
    const updated = await CallCockpitService.logCall(
      req.params._id,
      req.body,
      req.auth.user_id
    );
    res.status(200).json(updated);
  } catch (error) {
    const status = error.status || 500;
    const message = status === 500 ? "Something went wrong in the call cockpit — please retry." : error.message;
    res.status(status).json({ message });
  }
};

// POST /enquiry/:_id/follow-up
const AddFollowUp = async (req, res) => {
  try {
    const updated = await CallCockpitService.addFollowUp(
      req.params._id,
      req.body,
      req.auth.user_id
    );
    res.status(200).json(updated);
  } catch (error) {
    const status = error.status || 500;
    const message = status === 500 ? "Something went wrong in the call cockpit — please retry." : error.message;
    res.status(status).json({ message });
  }
};

// POST /enquiry/:_id/whatsapp-activity — log a WhatsApp deep-link press as
// employee activity (timeline + clears "contacted silent"); never sets firstCalledAt.
const WhatsappActivity = async (req, res) => {
  try {
    const event = await CallCockpitService.logWhatsappActivity(
      req.params._id,
      req.body,
      req.auth.user_id
    );
    res.status(200).json(event);
  } catch (error) {
    const status = error.status || 500;
    const message = status === 500 ? "Something went wrong in the call cockpit — please retry." : error.message;
    res.status(status).json({ message });
  }
};

// PUT /enquiry/:_id/qualification
const UpdateQualification = async (req, res) => {
  try {
    const updated = await CallCockpitService.updateQualification(
      req.params._id,
      req.body,
      req.auth.user_id
    );
    res.status(200).json(updated);
  } catch (error) {
    const status = error.status || 500;
    const message = status === 500 ? "Something went wrong in the call cockpit — please retry." : error.message;
    res.status(status).json({ message });
  }
};

// POST /enquiry/:_id/meet-refused (MB6 Slice 6)
const MeetRefused = async (req, res) => {
  try {
    const updated = await CallCockpitService.meetRefused(req.params._id, req.auth.user_id);
    res.status(200).json(updated);
  } catch (error) {
    const status = error.status || 500;
    const message = status === 500 ? "Something went wrong in the call cockpit — please retry." : error.message;
    res.status(status).json({ message });
  }
};

// POST /enquiry/:_id/call-complete
const CompleteCall = async (req, res) => {
  try {
    const updated = await CallCockpitService.completeCall(
      req.params._id,
      req.body,
      req.auth.user_id
    );
    res.status(200).json(updated);
  } catch (error) {
    const status = error.status || 500;
    const message = status === 500 ? "Something went wrong in the call cockpit — please retry." : error.message;
    res.status(status).json({ message });
  }
};

// GET /enquiry/:_id/internal-events
const GetInternalEvents = async (req, res) => {
  try {
    const events = await CallCockpitService.listInternalEvents(req.params._id);
    res.status(200).json(events);
  } catch (error) {
    const status = error.status || 500;
    const message = status === 500 ? "Something went wrong in the call cockpit — please retry." : error.message;
    res.status(status).json({ message });
  }
};

module.exports = {
  LogCall,
  WhatsappActivity,
  AddFollowUp,
  UpdateQualification,
  MeetRefused,
  CompleteCall,
  GetInternalEvents,
};
