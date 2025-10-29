import { RemoteControl } from '@limrun/ui';
import { useState } from 'react';
import { useAssets } from './useAssets';

function App() {
  const [instanceData, setInstanceData] = useState<{ id: string; webrtcUrl: string; token: string } | undefined>();
  const [loading, setLoading] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [androidVersion, setAndroidVersion] = useState('14');
  
  const { assets, addFiles, removeAsset, clearAssets, getUploadedAssetNames, areAllAssetsUploaded } = useAssets();

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    await addFiles(event.target.files);
    // Reset the input so the same file can be selected again if needed
    event.target.value = '';
  };

  const createInstance = async () => {
    try {
      setError(undefined);
      setLoading(true);

      // Check if all assets are uploaded
      if (!areAllAssetsUploaded()) {
        setError('Please wait for all assets to finish uploading');
        setLoading(false);
        return;
      }

      const response = await fetch('http://localhost:3000/create-instance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assetNames: getUploadedAssetNames(),
          androidVersion,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        setError(data.message || 'Failed to create instance');
        return;
      }

      setInstanceData({ id: data.id, webrtcUrl: data.webrtcUrl, token: data.token });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unknown error occurred');
    } finally {
      setLoading(false);
    }
  };

  const stopInstance = async () => {
    if (!instanceData) return;

    try {
      setError(undefined);
      setStopping(true);

      const response = await fetch('http://localhost:3000/stop-instance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instanceId: instanceData.id }),
      });

      const data = await response.json();
      if (!response.ok) {
        setError(data.message || 'Failed to stop instance');
        return;
      }

      // Clear instance data and assets after successful stop
      setInstanceData(undefined);
      clearAssets();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unknown error occurred');
    } finally {
      setStopping(false);
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
          <>
            <div
              style={{
                padding: '12px',
                backgroundColor: '#e8f5e9',
                color: '#2e7d32',
                borderRadius: '6px',
                fontSize: '13px',
                marginBottom: '10px',
              }}
            >
              Instance created successfully!
            </div>
            <button
              onClick={stopInstance}
              disabled={stopping}
              style={{
                width: '100%',
                padding: '12px',
                fontSize: '14px',
                fontWeight: '500',
                backgroundColor: stopping ? '#ccc' : '#dc3545',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                cursor: stopping ? 'not-allowed' : 'pointer',
                transition: 'background-color 0.2s',
              }}
            >
              {stopping ? 'Stopping...' : 'Stop Instance'}
            </button>
          </>
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
