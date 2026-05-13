import { useState, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { RemoteControl, RemoteControlHandle } from './components/remote-control';

function Demo() {
  const [url, setUrl] = useState('ws://localhost:8833/signaling');
  const [token, setToken] = useState('token');
  const [platform, setPlatform] = useState<'ios' | 'android'>('ios');
  const [isConnected, setIsConnected] = useState(false);
  const [key, setKey] = useState(0);
  const [showDebugInfo, setShowDebugInfo] = useState(false);
  
  const remoteControlRef = useRef<RemoteControlHandle>(null);

  const handleConnect = () => {
    if (url) {
      setIsConnected(true);
      // Force remount by changing key
      setKey(prev => prev + 1);
    }
  };

  const handleDisconnect = () => {
    setIsConnected(false);
    setKey(prev => prev + 1);
  };

  const handleScreenshot = async () => {
    if (remoteControlRef.current) {
      try {
        const screenshot = await remoteControlRef.current.screenshot();
        // Open screenshot in new window
        const win = window.open();
        if (win) {
          win.document.write(`<img src="${screenshot.dataUri}" style="max-width: 100%;" />`);
        }
      } catch (error) {
        console.error('Screenshot failed:', error);
        alert('Screenshot failed: ' + (error as Error).message);
      }
    }
  };

  return (
    <>
      <div className="header">
        <h1>📱 RemoteControl Component Demo</h1>
        <p>Test the iOS device frame and remote control features</p>
      </div>

      <div className="demo-container">
        <div className="info-box">
          <h4>ℹ️ How to Use:</h4>
          <p>
            Enter your WebSocket URL and authentication token below, select iOS or Android platform,
            then click Connect to see the remote control in action. The iOS platform will display
            a realistic iPhone frame around the stream.
          </p>
          <p style={{ marginTop: '10px', fontWeight: 600 }}>
            ✨ iOS Feature: Touches can start from the bottom bezel area (below the screen, near the 
            home indicator) to enable authentic iOS swipe-up gestures for going home or switching apps!
          </p>
        </div>

        <div className="controls">
          <div className="control-group">
            <label htmlFor="url">WebSocket URL</label>
            <input
              id="url"
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="wss://your-instance.limrun.com/control"
              disabled={isConnected}
            />
          </div>

          <div className="control-group">
            <label htmlFor="token">Authentication Token</label>
            <input
              id="token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Enter your token"
              disabled={isConnected}
            />
          </div>

          <div className="control-group">
            <label htmlFor="platform">Platform</label>
            <select
              id="platform"
              value={platform}
              onChange={(e) => setPlatform(e.target.value as 'ios' | 'android')}
              disabled={isConnected}
            >
              <option value="ios">iOS (with frame)</option>
              <option value="android">Android (no frame)</option>
            </select>
          </div>

          <div className="control-group">
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={showDebugInfo}
                onChange={(e) => setShowDebugInfo(e.target.checked)}
                style={{ cursor: 'pointer' }}
              />
              Show iOS Extended Touch Area Info
            </label>
          </div>

          <div className="button-group">
            {!isConnected ? (
              <button 
                className="primary" 
                onClick={handleConnect}
                disabled={!url}
              >
                Connect
              </button>
            ) : (
              <>
                <button className="secondary" onClick={handleDisconnect}>
                  Disconnect
                </button>
                <button className="primary" onClick={handleScreenshot}>
                  Take Screenshot
                </button>
              </>
            )}
          </div>
        </div>

        {showDebugInfo && platform === 'ios' && (
          <div style={{
            background: '#e0f2fe',
            border: '2px solid #0284c7',
            borderRadius: '8px',
            padding: '15px',
            marginBottom: '20px'
          }}>
            <h4 style={{ color: '#0c4a6e', marginBottom: '8px', fontSize: '0.95rem' }}>
              🔧 iOS Extended Touch Area
            </h4>
            <p style={{ color: '#075985', fontSize: '0.9rem', lineHeight: '1.5', margin: 0 }}>
              The iOS frame includes a <strong>60-pixel extended touch area</strong> below the visible screen.
              This area (where the home indicator is located) can receive touch events and sends coordinates
              beyond the screen bounds (y &gt; screenHeight), allowing iOS to properly detect gestures that
              start from outside the screen - just like on a real iPhone. Try starting a swipe gesture from
              the home indicator area!
            </p>
          </div>
        )}

        {isConnected ? (
          <div className="device-preview">
            <div className="preview-item">
              <h3>{platform === 'ios' ? '📱 iOS with Frame' : '🤖 Android (No Frame)'}</h3>
              <div className="device-wrapper">
                <RemoteControl
                  key={key}
                  ref={remoteControlRef}
                  url={url}
                  token={token}
                />
              </div>
            </div>
          </div>
        ) : (
          <div style={{ 
            textAlign: 'center', 
            padding: '60px 20px', 
            color: '#9ca3af',
            fontSize: '1.1rem'
          }}>
            Enter your connection details above and click Connect to start
          </div>
        )}
      </div>
    </>
  );
}

// Mount the demo app
const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<Demo />);
}
