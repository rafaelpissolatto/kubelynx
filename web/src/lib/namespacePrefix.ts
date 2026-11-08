// Namespace selection rules for the namespace picker (issue #86): what
// counts as "related" namespaces, what counts as a broad selection worth a
// warning, and what "Select all matching" adds. All pure, so the picker
// stays a thin rendering layer and the rules can be unit-tested or swapped.

// namespacePrefix returns a namespace's group: the segment before its first
// "-" (team-a-dev → "team"), or the whole name when it has no "-". Coarse
// on purpose: team-a-* and team-b-* are one group. Chosen on #86 as option
// (A) over longest-common-prefix and filter-based rules.
export function namespacePrefix(namespace: string): string {
  const dash = namespace.indexOf('-')
  return dash === -1 ? namespace : namespace.slice(0, dash)
}

// commonPrefix returns the group every namespace belongs to, or null when
// they span more than one group (or the list is empty).
export function commonPrefix(namespaces: readonly string[]): string | null {
  if (namespaces.length === 0) return null
  const prefix = namespacePrefix(namespaces[0])
  return namespaces.every((ns) => namespacePrefix(ns) === prefix) ? prefix : null
}

// isBroadSelection reports whether a selection is large enough, and
// unrelated enough, to warn that the graph may render slowly.
//
//   - threshold <= 0 turns the warning off.
//   - The "all namespaces" sentinel is broad once the cluster has at least
//     threshold namespaces, whatever their names.
//   - Otherwise the selection is broad when it has at least threshold
//     namespaces that don't all share one prefix (see namespacePrefix).
export function isBroadSelection(
  selected: readonly string[],
  allValue: string | null,
  clusterNamespaces: readonly string[],
  threshold: number,
): boolean {
  if (!(threshold > 0)) return false
  if (allValue !== null && selected.includes(allValue)) {
    return clusterNamespaces.length >= threshold
  }
  return selected.length >= threshold && commonPrefix(selected) === null
}

// matchingNamespaces is the set "Select all matching" acts on, in cluster
// order:
//   - with filter text, every namespace containing it (case-insensitive);
//   - without, every namespace in the current selection's group, when the
//     selection has one (and isn't "all namespaces");
//   - otherwise nothing.
export function matchingNamespaces(
  clusterNamespaces: readonly string[],
  filter: string,
  selected: readonly string[],
  allValue: string | null,
): string[] {
  const needle = filter.trim().toLowerCase()
  if (needle !== '') {
    return clusterNamespaces.filter((ns) => ns.toLowerCase().includes(needle))
  }
  if (allValue !== null && selected.includes(allValue)) return []
  const prefix = commonPrefix(selected)
  if (prefix === null) return []
  return clusterNamespaces.filter((ns) => namespacePrefix(ns) === prefix)
}

// WarningState drives the broad-selection banner. `broad` is the last
// observed isBroadSelection result; `visible` is whether the banner shows.
export interface WarningState {
  broad: boolean
  visible: boolean
}

// initialWarningState shows the banner straight away when the selection is
// already broad on first render (e.g. a ?namespace= URL with many groups).
export function initialWarningState(broad: boolean): WarningState {
  return { broad, visible: broad }
}

// nextWarningState applies a new isBroadSelection result. The banner shows
// once per upward crossing (not broad → broad), stays as it was while the
// selection stays broad (so a dismissal sticks), and clears when the
// selection stops being broad, re-arming it for the next crossing.
export function nextWarningState(prev: WarningState, broad: boolean): WarningState {
  if (broad === prev.broad) return prev
  return { broad, visible: broad }
}

// dismissWarning hides the banner until the next upward crossing.
export function dismissWarning(prev: WarningState): WarningState {
  return prev.visible ? { ...prev, visible: false } : prev
}
