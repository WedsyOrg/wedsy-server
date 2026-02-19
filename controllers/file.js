const AWS = require("@aws-sdk/client-s3");

const CreateNew = async (req, res) => {
  const { path, id } = req.body;
  
  // Check if file exists in req.files
  if (!req.files || !req.files.file) {
    return res.status(400).send({ message: "No file uploaded" });
  }
  
  const file = req.files.file;
  const { data, name, mimetype } = file;

  if (!name || !path || !id) {
    return res.status(400).send({ message: "Incomplete Data" });
  }
  
  try {
    const s3Client = new AWS.S3({
      region: process.env.AWS_S3_REGION,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });
    
    const extension = name.split(".").pop();
    const s3Key = `${path}/${id}.${extension}`;
    
    const params = {
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: s3Key,
      Body: data,
      ContentType: mimetype,
    };

    const result = await s3Client.putObject(params);
    
    let url = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_S3_REGION}.amazonaws.com/${s3Key}`;
    
    res.send({
      message: "File Uploaded Successfully",
      url,
    });
  } catch (error) {
    res.status(400).send({ 
      message: "AWS Upload Error", 
      error: {
        name: error.name,
        Code: error.Code,
        message: error.message,
        requestId: error.$metadata?.requestId,
      }
    });
  }
};

module.exports = { CreateNew };
