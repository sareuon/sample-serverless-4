import { APIGatewayProxyHandler, Context } from 'aws-lambda';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import sharp from 'sharp';

interface TiffData {
  buffer: Buffer;
  contentType: string;
}

const s3 = new S3Client({ region: 'us-east-1' });
const bucket = 'cog-tesing';

export const tile = async ( event: APIGatewayProxyEvent,_context: Context ): Promise<APIGatewayProxyResult> => {
    try {

      // Extract z, x, y from the path parameters
      const { z, x, y } = event.pathParameters as {
        z: string;
        x: string;
        y: string;
      };

    // Calculate the bounding box for the tile
    const tileSize = 256;
    const resolution = 0.00028 * Math.pow(2, parseInt(z));
    const bbox: [number, number, number, number] = [
      parseInt(x) * tileSize * resolution,
      parseInt(y) * tileSize * resolution,
      (parseInt(x) + 1) * tileSize * resolution,
      (parseInt(y) + 1) * tileSize * resolution,
    ];

    const { buffer, contentType } = await fetchTiffData(bbox, tileSize);


      return {
        // statusCode: 200,
        // body: JSON.stringify({
        //   message: 'Hello, world!',
        //   input: event,
        // }),
        statusCode: 200,
        headers: {
          'Content-Type': contentType,
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,X-Amz-User-Agent,Access-Control-Allow-Origin',
          'Access-Control-Allow-Methods': 'OPTIONS,GET'
        },
        body: buffer.toString('base64'),
        isBase64Encoded: true,
      }
    } catch (error) {
      return {
        statusCode: 500,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,X-Amz-User-Agent,Access-Control-Allow-Origin',
          'Access-Control-Allow-Methods': 'OPTIONS,GET'
        },
        body: JSON.stringify({ error: `An error occurred ${error}` }),
    };
  };
};

const fetchTiffData = async (bbox: [number, number, number, number], tileSize: number): Promise<TiffData> => {
  const { fromUrl } = await import('geotiff');
  const key = 'output_cog.tif';
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: 3600 }
  );

  const tiff = await fromUrl(url);
  const image = await tiff.getImage();
  const rasters = await image.readRasters({ window: bbox });

  // Convert rasters to PNG
  const buffer = await convertRastersToPng(rasters, tileSize, tileSize);

  return {
    buffer,
    contentType: "image/png"
  };
};

// Function to convert rasters to PNG using sharp
const convertRastersToPng = async (
    rasters: any,
    width: number,
    height: number
  ) => {

  // Combine the raster bands into an interleaved RGBA buffer
  const rgbaBuffer = Buffer.alloc(width * height * 4);

  for (let i = 0; i < width * height; i++) {
    rgbaBuffer[i * 4] = rasters[0][i]; // Red
    rgbaBuffer[i * 4 + 1] = rasters[1][i]; // Green
    rgbaBuffer[i * 4 + 2] = rasters[2][i]; // Blue
    rgbaBuffer[i * 4 + 3] = 255; // Alpha
  }

  // Use sharp to convert the RGBA buffer to a PNG buffer
  const pngBuffer = await sharp(rgbaBuffer, {
    raw: { width, height, channels: 4 },
  })
    .png()
    .toBuffer();

  return pngBuffer;
};