# Video recording in iOS

You can record the screen of the iOS simulator instance while
you use it by calling `startRecording` and `stopRecording` functions.

With `stopRecording` you can specify a local path to download the video file
or a pre-signed bucket URL to upload to a bucket directly from the simulator
host.

## Quick Start

Clone this repo and enter this example folder:
```bash
git clone https://github.com/limrun-inc/typescript-sdk.git
cd typescript-sdk/examples/ios-video-recording
```

Set up the example:
```bash
export LIM_API_KEY=<lim token from Console>
```
```bash
yarn install
```

Run it!
```bash
yarn run start
```

It will create an instance, start the recording, take a bunch of actions
and then save the recording to a local `video.mp4` file.

### Upload to S3 or Google Cloud Storage

You can have simulator upload directly to a pre-signed object URL by supplying that in `saveTo.s3Url` parameter of the `stopRecording` function.

Generate pre-signed URL in AWS:
```bash
#export AWS_ENDPOINT_URL
export AWS_ACCESS_KEY_ID=
export AWS_SECRET_ACCESS_KEY=

export S3_BUCKET=my-bucket
export S3_FILENAME=my-video.mp4

pip install -q boto3
python3 -c "import boto3,os; print(boto3.client('s3', config=boto3.session.Config(signature_version='s3v4')).generate_presigned_url('put_object', Params={'Bucket':os.environ['S3_BUCKET'],'Key':os.environ['S3_FILENAME']}, ExpiresIn=3600))"
```

Generate a pre-signed URL in Google Cloud Storage:

```bash
export GCS_BUCKET=
export GCS_FILENAME=
export GCS_SA_KEY_PATH=

gcloud storage sign-url gs://$GCS_BUCKET/$GCS_FILENAME --http-verb=PUT --duration=1h \
  --private-key-file=$GCS_SA_KEY_PATH
```