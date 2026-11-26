import { useCallback, useReducer, useRef } from 'react';

export type DeviceViewMode = '2d' | '3d';

/** The 2D and 3D choice of a device frame, the iPhone Duo's or the MacBook's. */
export interface DeviceView {
  /** What the viewer picked. */
  mode: DeviceViewMode;
  /**
   * What is on screen and takes input. 3D shows only once the 3D view says it is ready, so the 2D
   * view stays until then.
   */
  shown: DeviceViewMode;
  /** The viewer picked 3D and its code and model are still on their way. */
  loading: boolean;
  choose(mode: DeviceViewMode): void;
  /**
   * The 3D view is ready. Each pick of 3D gets its own callback, so one left from an earlier pick,
   * such as a load that finished after the viewer went back to 2D, changes nothing.
   */
  onReady(): void;
}

type State = { mode: DeviceViewMode; selection: number; ready: number };
type Action = { type: 'choose'; mode: DeviceViewMode } | { type: 'ready'; selection: number };

function reduce(state: State, action: Action): State {
  if (action.type === 'choose') {
    if (action.mode === state.mode) return state;
    return action.mode === '3d' ?
        { ...state, mode: '3d', selection: state.selection + 1 }
      : { ...state, mode: '2d' };
  }
  if (state.mode !== '3d' || action.selection !== state.selection || state.ready === action.selection) {
    return state;
  }
  return { ...state, ready: action.selection };
}

/**
 * useDeviceView keeps a device frame's 2D and 3D choice. `onShow3d` runs as the 3D view takes over
 * from the 2D one, before the 2D view stops taking input, so it can let go of what the 2D view holds.
 */
export function useDeviceView(onShow3d?: () => void): DeviceView {
  const [state, dispatch] = useReducer(reduce, { mode: '2d', selection: 0, ready: 0 });
  const latest = useRef(state);
  latest.current = state;
  const handoff = useRef(onShow3d);
  handoff.current = onShow3d;
  const { mode, selection, ready } = state;
  const choose = useCallback((next: DeviceViewMode) => dispatch({ type: 'choose', mode: next }), []);
  const onReady = useCallback(() => {
    const current = latest.current;
    if (current.mode !== '3d' || current.selection !== selection || current.ready === selection) return;
    handoff.current?.();
    dispatch({ type: 'ready', selection });
  }, [selection]);
  const loading = mode === '3d' && ready !== selection;
  return { mode, shown: mode === '3d' && !loading ? '3d' : '2d', loading, choose, onReady };
}

/** The 2D and 3D switch above a device frame. The 3D button spins while 3D downloads. */
export function DeviceModeToggle({ view, label }: { view: DeviceView; label: string }) {
  return (
    <div className="rc-duo-mode" role="group" aria-label={label}>
      <button type="button" aria-pressed={view.mode === '2d'} onClick={() => view.choose('2d')}>
        2D
      </button>
      <button
        type="button"
        aria-pressed={view.mode === '3d'}
        aria-busy={view.loading}
        title={view.loading ? 'Loading 3D' : undefined}
        onClick={() => view.choose('3d')}
      >
        3D
      </button>
    </div>
  );
}
