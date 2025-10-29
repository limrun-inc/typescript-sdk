import { useState } from 'react';
import SparkMD5 from 'spark-md5';

export interface Asset {
  file: File;
  name: string;
  assetName?: string;
  uploading: boolean;
  uploaded: boolean;
  error?: string;
}

const calculateMD5 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const chunkSize = 2097152; // 2MB chunks for better performance
    const spark = new SparkMD5.ArrayBuffer();
    const fileReader = new FileReader();
    let currentChunk = 0;
    const chunks = Math.ceil(file.size / chunkSize);

    fileReader.onload = (e) => {
      spark.append(e.target?.result as ArrayBuffer);
      currentChunk++;

      if (currentChunk < chunks) {
        loadNext();
      } else {
        resolve(spark.end());
      }
    };

    fileReader.onerror = () => {
      reject(new Error('Failed to read file for MD5 calculation'));
    };

    const loadNext = () => {
      const start = currentChunk * chunkSize;
      const end = Math.min(start + chunkSize, file.size);
      fileReader.readAsArrayBuffer(file.slice(start, end));
    };

    loadNext();
  });
};

export const useAssets = (backendUrl: string = 'http://localhost:3000') => {
  const [assets, setAssets] = useState<Asset[]>([]);

  const addFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;

    const newAssets = Array.from(files).map((file) => ({
      file,
      name: file.name,
      uploading: false,
      uploaded: false,
    }));

    setAssets((prev) => [...prev, ...newAssets]);

    // Start uploading files
    for (const asset of newAssets) {
      await uploadAsset(asset);
    }
  };

  const uploadAsset = async (asset: Asset) => {
    try {
      // Mark as uploading
      setAssets((prev) =>
        prev.map((a) => (a.file === asset.file ? { ...a, uploading: true, error: undefined } : a)),
      );

      // Calculate MD5 hash of the file
      const fileMD5 = await calculateMD5(asset.file);
      console.log(`Calculated MD5 for ${asset.name}: ${fileMD5}`);

      // Get presigned upload URL and check if file already exists
      const urlResponse = await fetch(`${backendUrl}/get-upload-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: asset.name }),
      });

      if (!urlResponse.ok) {
        throw new Error('Failed to get upload URL');
      }

      const { uploadUrl, assetName, md5 } = await urlResponse.json();

      // If MD5 matches (file already exists with same content), skip upload
      if (md5 && md5 === fileMD5) {
        console.log(`File ${asset.name} already exists with matching MD5, skipping upload`);
        setAssets((prev) =>
          prev.map((a) =>
            a.file === asset.file ? { ...a, uploading: false, uploaded: true, assetName } : a,
          ),
        );
        return;
      }

      console.log(`Uploading ${asset.name} to S3...`);
      // Upload file to S3
      const uploadResponse = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
        },
        body: asset.file,
      });

      if (!uploadResponse.ok) {
        throw new Error('Failed to upload file');
      }

      console.log(`Successfully uploaded ${asset.name}`);
      // Mark as uploaded
      setAssets((prev) =>
        prev.map((a) => (a.file === asset.file ? { ...a, uploading: false, uploaded: true, assetName } : a)),
      );
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Upload failed';
      setAssets((prev) =>
        prev.map((a) =>
          a.file === asset.file ? { ...a, uploading: false, uploaded: false, error: errorMessage } : a,
        ),
      );
    }
  };

  const removeAsset = (index: number) => {
    setAssets((prev) => prev.filter((_, i) => i !== index));
  };

  const clearAssets = () => {
    setAssets([]);
  };

  const getUploadedAssetNames = () => {
    return assets.filter((a) => a.uploaded && a.assetName).map((a) => a.assetName!);
  };

  const areAllAssetsUploaded = () => {
    if (assets.length === 0) return true;
    return assets.every((a) => a.uploaded);
  };

  return {
    assets,
    addFiles,
    removeAsset,
    clearAssets,
    getUploadedAssetNames,
    areAllAssetsUploaded,
  };
};
