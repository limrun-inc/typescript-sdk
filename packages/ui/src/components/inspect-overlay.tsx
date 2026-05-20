import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { clsx } from 'clsx';
import './inspect-overlay.css';

import {
  AxElement,
  AxPlatform,
  AxSnapshot,
  axElementRoleLabel,
  axElementSelectorExpression,
  axElementSummary,
  axElementsEqual,
  clampAxFrameForScreen,
} from '../core/ax-tree';

// Geometry of the rendered video content inside the RemoteControl container,
// after object-fit:contain letterboxing. All values are in container-local
// pixels (relative to .rc-container's content box) so the overlay boxes line
// up with the video.
//
// The InfoCard uses pointer-event coordinates (clientX/clientY) directly for
// its viewport-fixed placement and does NOT need any geometry — the boxes
// are the only thing geometry-locked.
export interface InspectOverlayGeometry {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type InspectMode = 'select' | 'hover-only';

export interface InspectOverlayProps {
  snapshot: AxSnapshot | null;
  geometry: InspectOverlayGeometry | null;
  highlightedId: string | null;
  selectedId: string | null;
  mode: InspectMode;
  // Current pointer position in viewport coordinates (clientX/Y). Drives the
  // cursor-anchored preview card while hovering. null when the pointer is
  // outside the device.
  cursorPosition: { x: number; y: number } | null;
  // Position where the selection was made (viewport coords). The card stays
  // anchored here once an element is selected so the user can interact with
  // its action buttons.
  frozenCursorPosition: { x: number; y: number } | null;
  // Selection callback. `clickPosition` is the viewport-space pointer
  // position at the moment of the click; pass null to clear selection.
  onSelectChange: (element: AxElement | null, clickPosition?: { x: number; y: number } | null) => void;
  // Called when the user presses "Tap" in the info card. `tapAt` is the
  // viewport-space pointer position the user originally aimed at (i.e. the
  // frozen click position) so we can tap that exact spot instead of an
  // averaged center.
  onTapElement: (element: AxElement, tapAt: { x: number; y: number }) => void;
}

const copyToClipboard = async (text: string): Promise<boolean> => {
  if (!text) return false;
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the textarea fallback.
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
};

// ────────────────────────────────────────────────────────────────────────────
// Single element box
// ────────────────────────────────────────────────────────────────────────────

interface InspectBoxProps {
  element: AxElement;
  screen: { width: number; height: number };
  highlighted: boolean;
  selected: boolean;
  selectable: boolean;
  onClick: (element: AxElement, clickPosition: { x: number; y: number }) => void;
}

const InspectBox = memo(
  function InspectBox({ element, screen, highlighted, selected, selectable, onClick }: InspectBoxProps) {
    const visible = clampAxFrameForScreen(element.frame, screen);
    if (!visible) return null;
    const summary = axElementSummary(element);
    return (
      <button
        type="button"
        className={clsx('rc-inspect-box', !element.enabled && 'rc-inspect-box-disabled')}
        data-ax-id={element.id}
        data-ax-path={element.path}
        data-ax-label={element.label || undefined}
        data-ax-role={element.role || undefined}
        data-highlighted={highlighted ? 'true' : 'false'}
        data-selected={selected ? 'true' : 'false'}
        aria-label={summary}
        // No onMouseEnter/Leave or `title` attr here — hover state is driven
        // by JS hit-testing in RemoteControl's handleInteraction (single
        // source of truth that handles overlapping boxes deterministically),
        // and the InfoCard already shows all the info the title would.
        onClick={(e) => {
          if (!selectable) return;
          e.preventDefault();
          e.stopPropagation();
          onClick(element, { x: e.clientX, y: e.clientY });
        }}
        style={{
          left: `${(visible.x / screen.width) * 100}%`,
          top: `${(visible.y / screen.height) * 100}%`,
          width: `${(visible.width / screen.width) * 100}%`,
          height: `${(visible.height / screen.height) * 100}%`,
        }}
      />
    );
  },
  (prev, next) =>
    prev.highlighted === next.highlighted &&
    prev.selected === next.selected &&
    prev.selectable === next.selectable &&
    prev.screen.width === next.screen.width &&
    prev.screen.height === next.screen.height &&
    prev.onClick === next.onClick &&
    axElementsEqual(prev.element, next.element),
);

// ────────────────────────────────────────────────────────────────────────────
// Info card (shown next to the focus element)
// ────────────────────────────────────────────────────────────────────────────

interface InfoCardProps {
  element: AxElement;
  platform: AxPlatform;
  // Viewport-coordinate anchor used to position the card. When cursorAnchored
  // is true the card sits at top-right of `anchor` and follows the cursor.
  // When false the card stays put at `anchor` (frozen on selection).
  anchor: { x: number; y: number };
  cursorAnchored: boolean;
  showActions: boolean;
  // Receives the element AND the viewport-space coordinate to tap at
  // (the frozen click position). Tapping at the click point — rather than
  // the element's frame center — preserves the user's aim when the
  // selected element is a container whose children are not exposed by the
  // accessibility tree (e.g. iOS UITabBar's button children).
  onTap: (element: AxElement, tapAt: { x: number; y: number }) => void;
}

// Upper bounds used only for "does the card fit on this side?" decisions.
// We do NOT use these to compute the actual top/left coordinates — see the
// CSS-transform-based placement below. Matches the CSS max-width /
// max-height so flip decisions stay accurate even when the card is at its
// largest (selected state with all action buttons visible).
const INFO_CARD_ESTIMATED_WIDTH = 260;
const INFO_CARD_ESTIMATED_HEIGHT = 220;
// Gap between the cursor and the nearest card edge. Tight enough that the
// card visibly "hangs" off the cursor, but not so tight that the OS pointer
// arrow visually overlaps the card border.
const CURSOR_OFFSET = 6;
// Distance from the window edge we try to maintain so the card never gets
// flush against the page chrome.
const VIEWPORT_PADDING = 8;

const InfoCard = memo(function InfoCard({
  element,
  platform,
  anchor,
  cursorAnchored,
  showActions,
  onTap,
}: InfoCardProps) {
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(null), 1100);
    return () => window.clearTimeout(t);
  }, [copied]);

  // Anchor the nearest card corner exactly CURSOR_OFFSET px from the cursor
  // using CSS transforms. By offsetting the card's coordinate by ±100% on
  // each axis as needed, we don't need to know the card's actual rendered
  // height/width — the corner that's nearest to the cursor sits at a known
  // distance regardless of card content. This solves the "huge gap" issue
  // that arises when the card content is much smaller than the assumed
  // worst-case height.
  //
  // Default: card's bottom-left corner sits to the top-right of the cursor
  // (so the card "hangs" off the cursor up-and-right, similar to system
  // tooltips). Flips to bottom-right if no room to the right, top-left if
  // no room above, and bottom-right if no room above-or-right.
  const cardStyle = useMemo<React.CSSProperties>(() => {
    const W = INFO_CARD_ESTIMATED_WIDTH;
    const H = INFO_CARD_ESTIMATED_HEIGHT;
    const O = CURSOR_OFFSET;
    const P = VIEWPORT_PADDING;

    const viewportW = typeof window !== 'undefined' ? window.innerWidth : 1024;
    const viewportH = typeof window !== 'undefined' ? window.innerHeight : 768;

    // Decide which quadrant of the cursor the card sits in. Use the
    // estimated max dimensions as the worst-case footprint when checking
    // for room.
    const placeRight = anchor.x + O + W <= viewportW - P;
    const placeAbove = anchor.y - O - H >= P;

    let left = placeRight ? anchor.x + O : anchor.x - O;
    let top = placeAbove ? anchor.y - O : anchor.y + O;

    // translate(-100% …) shifts the card by its own measured width/height,
    // which is what gives us the "corner anchored to cursor" behaviour
    // without having to know the rendered size in JS.
    const tx = placeRight ? '0' : '-100%';
    const ty = placeAbove ? '-100%' : '0';
    const transform = `translate(${tx}, ${ty})`;

    // Final clamp so the card never escapes the window even on tiny
    // viewports. Using the estimated dimensions as a safety margin.
    left = Math.max(P + (placeRight ? 0 : W), Math.min(viewportW - P - (placeRight ? W : 0), left));
    top = Math.max(P + (placeAbove ? H : 0), Math.min(viewportH - P - (placeAbove ? 0 : H), top));

    return { left: `${left}px`, top: `${top}px`, transform };
  }, [anchor.x, anchor.y]);

  const selectorExpr = useMemo(() => axElementSelectorExpression(element, platform), [element, platform]);
  const primaryIdField = platform === 'ios' ? element.selectors.AXUniqueId : element.selectors.resourceId;
  const primaryIdLabel = platform === 'ios' ? 'AXUniqueId' : 'resourceId';

  const handleCopy = useCallback(async (text: string | undefined, key: string) => {
    if (!text) return;
    const ok = await copyToClipboard(text);
    if (ok) setCopied(key);
  }, []);

  const roleLabel = axElementRoleLabel(element);
  // Title shows the element's label (clamped). Falls back to the role when no
  // label exists so the card never looks empty.
  const titleText = element.label || element.value || roleLabel;
  // axElementSummary is used as the full tooltip (truncated to ~80 chars).
  const fullSummary = axElementSummary(element);

  // We do not guard against SSR here: RemoteControl is fundamentally a
  // browser-only component (it instantiates RTCPeerConnection in its main
  // effect), so the InfoCard never gets rendered in a server environment.

  return createPortal(
    <div
      className="rc-inspect-card"
      data-cursor-anchored={cursorAnchored ? 'true' : 'false'}
      style={cardStyle}
      // The card sits in document.body but is logically a child of the
      // overlay React subtree, so events bubble back to rc-container's
      // mousemove handler. We stop them so hovering the card doesn't make
      // it chase itself.
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseMove={(e) => e.stopPropagation()}
    >
      <div className="rc-inspect-card-header">
        <span className="rc-inspect-card-role">{roleLabel}</span>
        {!element.enabled && <span className="rc-inspect-card-tag">disabled</span>}
        {element.focused && <span className="rc-inspect-card-tag rc-inspect-card-tag-blue">focused</span>}
      </div>
      <p className="rc-inspect-card-title" title={fullSummary}>
        {titleText}
      </p>
      {primaryIdField && (
        <div className="rc-inspect-card-row">
          <span className="rc-inspect-card-row-label">{primaryIdLabel}:</span>
          <span className="rc-inspect-card-row-value">{primaryIdField}</span>
        </div>
      )}
      {element.value && element.value !== element.label && (
        <div className="rc-inspect-card-row">
          <span className="rc-inspect-card-row-label">value:</span>
          <span className="rc-inspect-card-row-value">{element.value}</span>
        </div>
      )}
      <div className="rc-inspect-card-row">
        <span className="rc-inspect-card-row-label">frame:</span>
        <span className="rc-inspect-card-row-value">
          {Math.round(element.frame.width)}×{Math.round(element.frame.height)} @ {Math.round(element.frame.x)}
          ,{Math.round(element.frame.y)}
        </span>
      </div>
      {showActions && (
        <div className="rc-inspect-card-actions">
          <button
            type="button"
            className="rc-inspect-card-btn rc-inspect-card-btn-primary"
            onClick={() => onTap(element, anchor)}
          >
            Tap
          </button>
          <button
            type="button"
            className={clsx('rc-inspect-card-btn', copied === 'selector' && 'rc-inspect-card-btn-copied')}
            disabled={!selectorExpr}
            title={selectorExpr ?? 'No usable selector for this element'}
            onClick={() => handleCopy(selectorExpr ?? undefined, 'selector')}
          >
            {copied === 'selector' ? 'Copied!' : 'Copy selector'}
          </button>
          <button
            type="button"
            className={clsx('rc-inspect-card-btn', copied === 'id' && 'rc-inspect-card-btn-copied')}
            disabled={!primaryIdField}
            title={primaryIdField ?? `No ${primaryIdLabel}`}
            onClick={() => handleCopy(primaryIdField, 'id')}
          >
            {copied === 'id' ? 'Copied!' : `Copy ${primaryIdLabel}`}
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
});

// ────────────────────────────────────────────────────────────────────────────
// Overlay root
// ────────────────────────────────────────────────────────────────────────────

export const InspectOverlay = memo(function InspectOverlay({
  snapshot,
  geometry,
  highlightedId,
  selectedId,
  mode,
  cursorPosition,
  frozenCursorPosition,
  onSelectChange,
  onTapElement,
}: InspectOverlayProps) {
  const selectable = mode === 'select';

  // Card behaviour:
  //   - In `hover-only` mode there is no selection. The card always follows
  //     the cursor and only renders when something is highlighted.
  //   - In `select` mode the card follows the cursor whenever the user is
  //     hovering an element OTHER than the currently selected one (preview).
  //     Hovering the selected element or moving the cursor off any box keeps
  //     the card frozen at the click position so the action buttons remain
  //     reachable.
  const isPreviewingHover =
    selectable ? highlightedId !== null && highlightedId !== selectedId : highlightedId !== null;
  const focusId = selectable ? highlightedId ?? selectedId : highlightedId;

  // Build an `id → element` index once per snapshot so focus lookups are O(1)
  // even on max-size trees. Hooks must run unconditionally — gate rendering
  // afterwards via the `renderable` check.
  const elementsById = useMemo(() => {
    const m = new Map<string, AxElement>();
    if (!snapshot) return m;
    for (const el of snapshot.elements) m.set(el.id, el);
    return m;
  }, [snapshot]);

  const focusElement = useMemo(() => {
    if (!focusId) return null;
    return elementsById.get(focusId) ?? null;
  }, [focusId, elementsById]);

  // The overlay has nothing to draw until both a snapshot and the device
  // geometry are available, and the snapshot has at least one usable
  // element. Conditional rendering goes here — AFTER all hooks — so the
  // hook-count is stable across the snapshot-arrives-after-mount transition.
  const renderable =
    !!snapshot &&
    !!geometry &&
    snapshot.screen.width > 0 &&
    snapshot.screen.height > 0 &&
    snapshot.elements.length > 0;
  if (!renderable) return null;

  const anchor = isPreviewingHover ? cursorPosition : frozenCursorPosition ?? cursorPosition;
  const cursorAnchored = isPreviewingHover;
  const showActions = selectable && !isPreviewingHover && selectedId !== null;

  const handleContainerClick = (e: React.MouseEvent) => {
    if (!selectable) return;
    // Click was on the container itself (not a box) — clear selection.
    if (e.target === e.currentTarget) {
      onSelectChange(null, null);
    }
  };

  return (
    <>
      <div
        className={clsx('rc-inspect-overlay', selectable && 'rc-inspect-overlay-select')}
        style={{
          left: `${geometry!.left}px`,
          top: `${geometry!.top}px`,
          width: `${geometry!.width}px`,
          height: `${geometry!.height}px`,
        }}
        onClick={handleContainerClick}
      >
        {snapshot!.elements.map((element) => (
          <InspectBox
            key={element.id}
            element={element}
            screen={snapshot!.screen}
            highlighted={element.id === highlightedId}
            selected={element.id === selectedId}
            selectable={selectable}
            onClick={onSelectChange}
          />
        ))}
      </div>
      {focusElement && anchor && (
        <InfoCard
          element={focusElement}
          platform={snapshot!.platform}
          anchor={anchor}
          cursorAnchored={cursorAnchored}
          showActions={showActions}
          onTap={onTapElement}
        />
      )}
    </>
  );
});
