const express = require('express');
const router = express.Router({ mergeParams: true });
const { CheckLogin } = require('../middlewares/auth');
const {
  GetTimeline,
  CreateMilestone,
  UpdateMilestone,
  DeleteMilestone,
} = require('../controllers/weddingTimeline');

router.get('/', CheckLogin, GetTimeline);
router.post('/', CheckLogin, CreateMilestone);
router.patch('/:milestoneId', CheckLogin, UpdateMilestone);
router.delete('/:milestoneId', CheckLogin, DeleteMilestone);

module.exports = router;
