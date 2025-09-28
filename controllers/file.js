const AWS = require("@aws-sdk/client-s3");

const CreateNew = async (req, res) => {
  console.log("File upload request received");
  console.log("req.body:", req.body);
  console.log("req.files:", req.files);
  
  const { path, id } = req.body;
  
  // Check if file exists in req.files
  if (!req.files || !req.files.file) {
    console.log("No file found in req.files");
    return res.status(400).send({ message: "No file uploaded" });
  }
  
  const file = req.files.file;
  const { data, name, mimetype } = file;
  
  console.log("File details:", { name, mimetype, dataLength: data ? data.length : 'no data' });

  if (!name || !path || !id) {
    return res.status(400).send({ message: "Incomplete Data" });
  } else {
    const s3Client = new AWS.S3({
      region: process.env.AWS_S3_REGION,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });
    const extension = name.split(".").pop();
    const params = {
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: `${path}/${id}.${extension}`,
      Body: data,
      ContentType: mimetype,
      ACL: "public-read",
    };

    try {
      const result = await s3Client.putObject(params);
      let url = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_S3_REGION}.amazonaws.com/${params.Key}`;
      res.send({
        message: "File Uploaded Successfully",
        url,
      });
    } catch (error) {
      res.status(400).send({ message: "AWS Upload Error", error });
    }
  }
};

module.exports = { CreateNew };
