import { RemoteControl } from '@limrun/ui';
import { useState } from 'react';

function App() {
  const [instanceData, setInstanceData] = useState<
    | {
        webrtcUrl: string;
        token: string;
      }
    | undefined
  >(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  // State to hold asset paths that user wants to upload
  const [assetPaths, setAssetPaths] = useState<string[]>(['']);

  const handleAssetPathChange = (index: number, value: string) => {
    const newPaths = [...assetPaths];
    newPaths[index] = value;
    setAssetPaths(newPaths);
  };

  const addAssetInput = () => {
    setAssetPaths([...assetPaths, '']);
  };

  const removeAssetInput = (index: number) => {
    setAssetPaths(assetPaths.filter((_, i) => i !== index));
  };

  const createInstance = async () => {
    try {
      // Clear any previous errors and set loading state
      setError(undefined);
      setLoading(true);

      const response = await fetch('http://localhost:3000/create-instance', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // 'X-Forwarded-For': '38.32.68.57',
        },
        body: JSON.stringify({
          assets: assetPaths.filter((p) => p.trim() !== '').map((path) => ({ path })),
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.message || 'Request creation failed');
        return;
      }
      setInstanceData({
        webrtcUrl: data.webrtcUrl,
        token: data.token,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unknown error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container" style={{ padding: '20px', maxWidth: '800px', margin: '0 auto' }}>
      <h1>Limrun Remote Control</h1>

      {!instanceData && (
        <div style={{ marginBottom: '20px' }}>
          {/* Asset path inputs */}
          <div style={{ marginBottom: '20px' }}>
            <h3>Assets</h3>
            {assetPaths.map((path, idx) => (
              <div key={idx} style={{ display: 'flex', alignItems: 'center', marginBottom: '10px' }}>
                <input
                  type="text"
                  placeholder="Enter asset file path"
                  value={path}
                  onChange={(e) => handleAssetPathChange(idx, e.target.value)}
                  style={{ flex: 1, padding: '8px' }}
                />
                {assetPaths.length > 1 && (
                  <button
                    onClick={() => removeAssetInput(idx)}
                    style={{
                      marginLeft: '10px',
                      padding: '8px 12px',
                      backgroundColor: '#dc3545',
                      color: 'white',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: 'pointer',
                    }}
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}
            <button
              onClick={addAssetInput}
              style={{
                padding: '8px 12px',
                fontSize: '14px',
                backgroundColor: '#28a745',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
              }}
            >
              Add Asset Path
            </button>
          </div>

          {/* Create Instance button */}
          <button
            onClick={createInstance}
            disabled={loading}
            style={{
              padding: '10px 20px',
              fontSize: '16px',
              backgroundColor: loading ? '#cccccc' : '#007bff',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: loading ? 'not-allowed' : 'pointer',
            }}
          >
            {loading ? 'Creating Instance...' : 'Create New Instance'}
          </button>
        </div>
      )}

      {error && (
        <div
          style={{
            padding: '10px',
            backgroundColor: '#f8d7da',
            color: '#721c24',
            borderRadius: '4px',
            marginBottom: '20px',
          }}
        >
          <strong>Error:</strong> {error}
        </div>
      )}

      {instanceData && (
        <>
          <div
            style={{
              padding: '10px',
              backgroundColor: '#d4edda',
              color: '#155724',
              borderRadius: '4px',
              marginBottom: '20px',
            }}
          >
            Instance created successfully! Remote control is ready.
          </div>
          <RemoteControl
            url={instanceData.webrtcUrl}
            token={instanceData.token}
            sessionId={`session-${Date.now()}`}
          />
        </>
      )}
    </div>
  );
}

export default App;
