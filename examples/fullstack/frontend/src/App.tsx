import { RemoteControl } from '@limrun/ui';
import { useState } from 'react';

function App() {
  const [instanceData, setInstanceData] = useState<
    {
      id: string;
      webrtcUrl: string;
      token: string;
      platform: 'android' | 'ios';
      iosModel?: 'iphone' | 'ipad' | 'watch';
    } | undefined
  >();
  const [loading, setLoading] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [platform, setPlatform] = useState<'android' | 'ios'>('ios');
  const [iosModel, setIosModel] = useState<'iphone' | 'ipad' | 'watch'>('iphone');
  const [openUrl, setOpenUrl] = useState('');
  const [withExpoGo54, setWithExpoGo54] = useState(false);

  const createInstance = async () => {
    try {
      setError(undefined);
      setLoading(true);

      const response = await fetch('http://localhost:3000/create-instance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform,
          iosModel,
          withExpoGo54,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        setError(data.message || 'Failed to create instance');
        return;
      }

      setInstanceData({ id: data.id, webrtcUrl: data.webrtcUrl, token: data.token, platform, iosModel });
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
        body: JSON.stringify({ instanceId: instanceData.id, platform: instanceData.platform }),
      });

      const data = await response.json();
      if (!response.ok) {
        setError(data.message || 'Failed to stop instance');
        return;
      }

      setInstanceData(undefined);
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
                Platform
              </label>
              <select
                value={platform}
                onChange={(e) => setPlatform(e.target.value as 'android' | 'ios')}
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
                <option value="android">Android</option>
                <option value="ios">iOS</option>
              </select>
            </div>

            {platform === 'ios' && (
              <div>
                <label style={{ display: 'block', marginBottom: '8px', fontSize: '14px', fontWeight: '500' }}>
                  iOS Model
                </label>
                <select
                  value={iosModel}
                  onChange={(e) => setIosModel(e.target.value as 'iphone' | 'ipad' | 'watch')}
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
                  <option value="iphone">iPhone</option>
                  <option value="ipad">iPad</option>
                  <option value="watch">Apple Watch</option>
                </select>
              </div>
            )}

            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                fontSize: '14px',
                fontWeight: '500',
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={withExpoGo54}
                onChange={(e) => setWithExpoGo54(e.target.checked)}
                style={{ width: '16px', height: '16px' }}
              />
              With Expo Go 54
            </label>

            <div>
              <label style={{ display: 'block', marginBottom: '8px', fontSize: '14px', fontWeight: '500' }}>
                Open with URL
              </label>
              <input
                type="text"
                placeholder="e.g., https://example.com"
                value={openUrl}
                onChange={(e) => setOpenUrl(e.target.value)}
                style={{
                  width: '100%',
                  padding: '10px',
                  border: '1px solid #ddd',
                  borderRadius: '6px',
                  fontSize: '14px',
                  boxSizing: 'border-box',
                }}
              />
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
        {instanceData ?
          <div style={{ width: '100%', height: '100%', maxWidth: '1000px', maxHeight: '700px' }}>
            <RemoteControl
              url={instanceData.webrtcUrl}
              token={instanceData.token}
              sessionId={`session-${Date.now()}`}
              showFrame={instanceData.platform !== 'ios' || instanceData.iosModel === 'iphone'}
              {...(openUrl.trim() && { openUrl: openUrl.trim() })}
            />
          </div>
        : <div style={{ textAlign: 'center', color: '#999', fontSize: '16px' }}>
            Configure settings and create an instance to begin
          </div>
        }
      </div>
    </div>
  );
}

export default App;
