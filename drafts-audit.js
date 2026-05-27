require('dotenv').config();
const mongoose = require('mongoose');
mongoose.connect(process.env.MONGODB_ATLAS_URL || process.env.DATABASE_URL).then(async () => {
  const Venue = require('./models/Venue');

  const drafts = await Venue.find({
    status: 'draft',
    name: { $exists: true, $ne: '' }
  }).select('name slug description coverPhoto address zone locality').lean();

  console.log('Total drafts found:', drafts.length);
  console.log('With coverPhoto:', drafts.filter(v => v.coverPhoto).length);
  console.log('Without coverPhoto:', drafts.filter(v => !v.coverPhoto).length);
  console.log('With description:', drafts.filter(v => v.description).length);
  console.log('Without description:', drafts.filter(v => !v.description).length);

  drafts.forEach(v => console.log(`- ${v.name} | photo:${v.coverPhoto ? 'YES' : 'NO'} | desc:${v.description ? 'YES' : 'NO'} | addr:${v.address ? 'YES' : 'NO'}`));

  mongoose.disconnect();
});
