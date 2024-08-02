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

// Constants
const tileSize = 256;
const webMercatorExtent = 20037508.3427892;

export const tile: APIGatewayProxyHandler = async (
  event: APIGatewayProxyEvent,
  _context: Context
): Promise<APIGatewayProxyResult> => {
  try {
    // Extract z, x, y from the path parameters
    const { z, x, y } = event.pathParameters as {
      z: string;
      x: string;
      y: string;
    };

    const webMercatorBbox: [number, number, number, number] = tileToWebMercator(
      parseInt(x),
      parseInt(y),
      parseInt(z)
    );
    const { buffer, contentType } = await fetchTiffData(webMercatorBbox, tileSize);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers':
          'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,X-Amz-User-Agent,Access-Control-Allow-Origin',
        'Access-Control-Allow-Methods': 'OPTIONS,GET',
      },
      body: buffer.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers':
          'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,X-Amz-User-Agent,Access-Control-Allow-Origin',
        'Access-Control-Allow-Methods': 'OPTIONS,GET',
      },
      body: JSON.stringify({ error: `An error occurred ${error}` }),
    };
  }
};

const fetchTiffData = async (
  bbox: [number, number, number, number],
  tileSize: number
): Promise<TiffData> => {

  const { fromUrl } = await import('geotiff');
  const key = 'output_cog.tif';
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: 3600 }
  );

  const tiff = await fromUrl(url);
  const image = await tiff.getImage();

  // Log image metadata
  const imageWidth = image.getWidth();
  const imageHeight = image.getHeight();
  const geoTransform = image.getGeoKeys();
  console.log('Image Metadata:', { imageWidth, imageHeight, geoTransform });

  console.log(bbox);
  const [imageMinX, imageMinY, imageMaxX, imageMaxY] = image.getBoundingBox();
  console.log('Image Bounding Box:', [imageMinX, imageMinY, imageMaxX, imageMaxY]);
  


  // const rasterBbox = await webMercatorToPixel(bbox, image);
  const rasters = await image.readRasters({ window: bbox});
  
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
): Promise<Buffer> => {

  // Combine the raster bands into an interleaved RGBA buffer
  const rgbaBuffer = Buffer.alloc(width * height * 4);

  for (let i = 0; i < width * height; i++) {
    rgbaBuffer[i * 4] = rasters[0][i]; // Red
    rgbaBuffer[i * 4 + 1] = rasters[1][i]; // Green
    rgbaBuffer[i * 4 + 2] = rasters[2][i]; // Blue
    rgbaBuffer[i * 4 + 3] = 0; // Alpha
  }

  // Use sharp to convert the RGBA buffer to a PNG buffer
  const pngBuffer = await sharp(rgbaBuffer, {
    raw: { width, height, channels: 4 },
  })
    .png()
    .toBuffer();

  return pngBuffer;
};

// Corrected function to convert Web Mercator coordinates to pixel coordinates
const webMercatorToPixel = (
  bbox: [number, number, number, number],
  image: any
): [number, number, number, number] => {
  const [minX, minY, maxX, maxY] = bbox;
  const imageWidth = image.getWidth();
  const imageHeight = image.getHeight();
  const [imageMinX, imageMaxY] = image.getOrigin();
  const imageResolution = image.getResolution
    ? image.getResolution()
    : webMercatorExtent * 2 / imageWidth;

  const pixelMinX = Math.round((minX - imageMinX) / imageResolution);
  const pixelMaxY = Math.round((imageMaxY - minY) / imageResolution);
  const pixelMaxX = Math.round((maxX - imageMinX) / imageResolution);
  const pixelMinY = Math.round((imageMaxY - maxY) / imageResolution);

  // Ensure pixel values are within the image dimensions
  const boundedPixelMinX = Math.max(0, Math.min(pixelMinX, imageWidth));
  const boundedPixelMaxX = Math.max(0, Math.min(pixelMaxX, imageWidth));
  const boundedPixelMinY = Math.max(0, Math.min(pixelMinY, imageHeight));
  const boundedPixelMaxY = Math.max(0, Math.min(pixelMaxY, imageHeight));

  return [boundedPixelMinX, boundedPixelMinY, boundedPixelMaxX, boundedPixelMaxY];
};

// Function to convert tile coordinates to Web Mercator coordinates
const tileToWebMercator = (
  x: number,
  y: number,
  z: number
): [number, number, number, number] => {
  const resolution = getResolution(z);
  const minX: number = x * tileSize * resolution - webMercatorExtent;
  const maxY: number = webMercatorExtent - y * tileSize * resolution;
  const maxX: number = (x + 1) * tileSize * resolution - webMercatorExtent;
  const minY: number = webMercatorExtent - (y + 1) * tileSize * resolution;
  return [minX, minY, maxX, maxY];
};

const getResolution = (z: number): number => {
  return (2 * webMercatorExtent) / (tileSize * Math.pow(2, z));
};
