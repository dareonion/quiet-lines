// Palm rejection for Apple Pencil.
//
// Safari on iPad gives a web page no contact size (no radiusX/radiusY), so a resting hand can't be
// told from a finger by its shape, only by timing. While the Pencil is in use (touching the screen,
// hovering over it, or seen within QUIET_MS), a new touch is taken to be the child's hand. When the Pencil
// is on the screen, touches already down become that hand too. A hand:
// - draws nothing and counts for no trace; ink it made before the Pencil landed is removed
//   (draw.js and trace/surface.js ask isPalm, and hear onPalms when the Pencil lands);
// - doesn't hold the parent gear open (home.js);
// - presses nothing: the click its lift makes on that element is dropped.
// A finger works again QUIET_MS after the Pencil was last seen. Mouse input is never a hand.

export const QUIET_MS = 1500;
const CLICK_MS = 600;          // a click follows its lift at once; this is generous
const PEN_STALE_MS = 30000;    // a Pencil "down" with no event for this long lost its lift
const LIFTED_KEEP_MS = 5000;   // a lifted hand stays known this long, for the page's own lift handlers

export function createPalmGuard(now = () => performance.now()) {
  let penAt = -Infinity;
  const pensDown = new Set();
  const touchesDown = new Set();
  const palms = new Set();       // hands still down
  const lifted = new Map();      // hand id -> lift time (see LIFTED_KEEP_MS)
  let lifts = [];              // {target, until}: where a hand lifted; its click there is dropped
  const listeners = new Set();
  const penInUse = (t) => (pensDown.size > 0 && t - penAt < PEN_STALE_MS) || t - penAt < QUIET_MS;
  return {
    /** Every pointer event, before the page's own handlers see it. */
    observe(e) {
      const t = now();
      const up = e.type === 'pointerup' || e.type === 'pointercancel';
      if (e.type === 'pointerdown') {
        // A new contact is judged afresh, whatever an earlier one with this id was.
        palms.delete(e.pointerId);
        lifted.delete(e.pointerId);
        for (const [id, at] of lifted) if (t - at > LIFTED_KEEP_MS) lifted.delete(id);
      }
      if (e.pointerType === 'pen') {
        penAt = t;
        if (e.type === 'pointerdown') pensDown.add(e.pointerId);
        else if (up) pensDown.delete(e.pointerId);
        // The Pencil is on the screen: any touch still down is a resting hand.
        if (pensDown.has(e.pointerId)) {
          const caught = [...touchesDown].filter((id) => !palms.has(id));
          for (const id of caught) palms.add(id);
          if (caught.length) for (const fn of listeners) fn(caught);
        }
        return;
      }
      if (e.pointerType !== 'touch') return;
      if (e.type === 'pointerdown') {
        touchesDown.add(e.pointerId);
        if (penInUse(t)) palms.add(e.pointerId);
      } else if (up) {
        touchesDown.delete(e.pointerId);
        if (palms.delete(e.pointerId)) {
          lifted.set(e.pointerId, t);
          // Only a lift makes a click; a cancelled touch makes none.
          if (e.type === 'pointerup') {
            lifts = lifts.filter((l) => l.until > t);
            lifts.push({ target: e.target, until: t + CLICK_MS });
          }
        }
      }
    },
    /** Whether this pointer is (now known to be) a resting hand. */
    isPalm(pointerId) { return palms.has(pointerId) || lifted.has(pointerId); },
    /** fn(ids) when the Pencil lands while touches are down. Returns an unsubscribe function. */
    onPalms(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** For each click: true means a hand just lifted on this element, so drop the click. */
    takeClick(target) {
      const t = now();
      lifts = lifts.filter((l) => l.until > t);
      // A touch's click goes to the element it lifted on, or an ancestor (capture released), never
      // to something inside it: a Pencil tap on a button inside where a hand lifted is not the hand's.
      const same = (l) => !l.target || !target || l.target === target || target.contains?.(l.target);
      const i = lifts.findIndex(same);
      if (i < 0) return false;
      lifts.splice(i, 1);
      return true;
    },
    /** The app was hidden: lifts may have been lost. */
    reset() { pensDown.clear(); touchesDown.clear(); palms.clear(); lifted.clear(); lifts = []; },
  };
}

export const palm = createPalmGuard();

/** Wire the guard to the document (main.js, once). Capture phase, so it sees events first. */
export function installPalmGuard(doc = document) {
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
    doc.addEventListener(type, (e) => palm.observe(e), { capture: true, passive: true });
  }
  doc.addEventListener('click', (e) => {
    if (palm.takeClick(e.target)) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, { capture: true });
  doc.addEventListener('visibilitychange', () => { if (doc.hidden) palm.reset(); });
}
