import { RemoteControl } from '@limrun/ui';
import { useState } from 'react';

interface Asset {
  file: File;
  name: string;
  assetName?: string;
  uploading: boolean;
  uploaded: boolean;
  error?: string;
}

function App() {
  const [instanceData, setInstanceData] = useState<{ webrtcUrl: string; token: string } | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [androidVersion, setAndroidVersion] = useState('14');

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files && files.length > 0) {
      const newAssets = Array.from(files).map((file) => ({
        file,
        name: file.name,
        uploading: false,
        uploaded: false,
      }));
      setAssets([...assets, ...newAssets]);
      
      // Start uploading files
      for (const asset of newAssets) {
        await uploadAsset(asset);
      }
    }
    // Reset the input so the same file can be selected again if needed
    event.target.value = '';
  };

  const uploadAsset = async (asset: Asset) => {
    try {
      // Mark as uploading
      setAssets((prev) =>
        prev.map((a) => (a.file === asset.file ? { ...a, uploading: true, error: undefined } : a)),
      );

      // Get presigned upload URL
      const urlResponse = await fetch('http://localhost:3000/get-upload-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: asset.name }),
      });

      if (!urlResponse.ok) {
        throw new Error('Failed to get upload URL');
      }

      const { uploadUrl, assetName } = await urlResponse.json();

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

      // Mark as uploaded
      setAssets((prev) =>
        prev.map((a) =>
          a.file === asset.file ? { ...a, uploading: false, uploaded: true, assetName } : a,
        ),
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
    setAssets(assets.filter((_, i) => i !== index));
  };

  const createInstance = async () => {
    try {
      setError(undefined);
      setLoading(true);

      // Check if all assets are uploaded
      const uploadedAssets = assets.filter((a) => a.uploaded && a.assetName);
      if (assets.length > 0 && uploadedAssets.length !== assets.length) {
        setError('Please wait for all assets to finish uploading');
        setLoading(false);
        return;
      }

      const response = await fetch('http://localhost:3000/create-instance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assetNames: uploadedAssets.map((a) => a.assetName),
          androidVersion,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        setError(data.message || 'Failed to create instance');
        return;
      }

      setInstanceData({ webrtcUrl: data.webrtcUrl, token: data.token });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unknown error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        height: '100vh',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      {/* Left Sidebar */}
      <div
        style={{
          width: '300px',
          padding: '24px',
          backgroundColor: '#f8f9fa',
          borderRight: '1px solid #e0e0e0',
          display: 'flex',
          flexDirection: 'column',
          gap: '20px',
          boxSizing: 'border-box',
        }}
      >
        <h1 style={{ margin: '0', fontSize: '20px', fontWeight: '600' }}>Limrun Remote Control</h1>

        {!instanceData && (
          <>
            <div>
              <label style={{ display: 'block', marginBottom: '8px', fontSize: '14px', fontWeight: '500' }}>
                Android Version
              </label>
              <select
                value={androidVersion}
                onChange={(e) => setAndroidVersion(e.target.value)}
                style={{
                  width: '100%',
                  padding: '10px',
                  border: '1px solid #ddd',
                  borderRadius: '6px',
                  fontSize: '14px',
                  boxSizing: 'border-box',
                  backgroundColor: 'white',
                  cursor: 'pointer',
                }}
              >
                <option value="14">Android 14</option>
                <option value="15">Android 15</option>
              </select>
            </div>

            <div>
              <label style={{ display: 'block', marginBottom: '8px', fontSize: '14px', fontWeight: '500' }}>
                Assets (optional)
              </label>
              
              {assets.length > 0 && (
                <div style={{ marginBottom: '10px' }}>
                  {assets.map((asset, index) => (
                    <div
                      key={index}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        padding: '8px',
                        backgroundColor: 'white',
                        border: '1px solid #ddd',
                        borderRadius: '4px',
                        marginBottom: '6px',
                        fontSize: '13px',
                      }}
                    >
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {asset.name}
                      </span>
                      {asset.uploading && (
                        <span style={{ fontSize: '11px', color: '#0066ff' }}>Uploading...</span>
                      )}
                      {asset.uploaded && (
                        <span style={{ fontSize: '11px', color: '#28a745' }}>✓</span>
                      )}
                      {asset.error && (
                        <span style={{ fontSize: '11px', color: '#dc3545' }}>✗</span>
                      )}
                      <button
                        onClick={() => removeAsset(index)}
                        disabled={asset.uploading}
                        style={{
                          padding: '4px 8px',
                          fontSize: '12px',
                          backgroundColor: asset.uploading ? '#ccc' : '#dc3545',
                          color: 'white',
                          border: 'none',
                          borderRadius: '4px',
                          cursor: asset.uploading ? 'not-allowed' : 'pointer',
                        }}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
              
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                  padding: '10px',
                  border: '2px dashed #ddd',
                  borderRadius: '6px',
                  fontSize: '14px',
                  color: '#666',
                  cursor: 'pointer',
                  backgroundColor: 'white',
                  transition: 'border-color 0.2s',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.borderColor = '#0066ff')}
                onMouseLeave={(e) => (e.currentTarget.style.borderColor = '#ddd')}
              >
                <span style={{ fontSize: '18px' }}>+</span>
                Add File
                <input
                  type="file"
                  multiple
                  onChange={handleFileSelect}
                  style={{ display: 'none' }}
                />
              </label>
            </div>

            <button
              onClick={createInstance}
              disabled={loading}
              style={{
                width: '100%',
                padding: '12px',
                fontSize: '14px',
                fontWeight: '500',
                backgroundColor: loading ? '#ccc' : '#0066ff',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                cursor: loading ? 'not-allowed' : 'pointer',
                transition: 'background-color 0.2s',
              }}
            >
              {loading ? 'Creating...' : 'Create Instance'}
            </button>
          </>
        )}

        {error && (
          <div
            style={{
              padding: '12px',
              backgroundColor: '#fee',
              color: '#c33',
              borderRadius: '6px',
              fontSize: '13px',
            }}
          >
            {error}
          </div>
        )}

        {instanceData && (
          <div
            style={{
              padding: '12px',
              backgroundColor: '#e8f5e9',
              color: '#2e7d32',
              borderRadius: '6px',
              fontSize: '13px',
            }}
          >
            Instance created successfully!
          </div>
        )}
      </div>

      {/* Main Content Area */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          padding: '20px',
          boxSizing: 'border-box',
        }}
      >
        {instanceData ? (
          <div style={{ width: '100%', height: '100%', maxWidth: '1000px', maxHeight: '700px' }}>
            <RemoteControl
              url={instanceData.webrtcUrl}
              token={instanceData.token}
              sessionId={`session-${Date.now()}`}
            />
          </div>
        ) : (
          <div style={{ textAlign: 'center', color: '#999', fontSize: '16px' }}>
            Configure settings and create an instance to begin
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
