import type { SidebarSectionEntry } from '@/lib/sidebarSections';

/**
 * One section drop, as the manager reads it from the drag: `nest` places the
 * section under the one it was dropped on, `out` lifts it to the top level
 * after that section's parent, `keep` leaves it where it was dropped at its
 * own level.
 */
export type SectionDropIntent = 'nest' | 'out' | 'keep';

/** Projects is the catch-all and never a container. */
const canParentSections = (entry: SidebarSectionEntry): boolean => (
  !(entry.kind === 'builtin' && entry.id === 'projects')
);

const childrenOf = (sections: readonly SidebarSectionEntry[], parentId: string): SidebarSectionEntry[] => (
  sections.filter((entry) => entry.parentId === parentId)
);

const withParent = (entry: SidebarSectionEntry, parentId: string): SidebarSectionEntry => (
  entry.kind === 'builtin' ? { kind: 'builtin', id: entry.id, parentId } : { ...entry, parentId }
);

/** One entry at the top level, its parent dropped. */
export const liftSection = (entry: SidebarSectionEntry): SidebarSectionEntry => {
  if (entry.kind === 'builtin') return { kind: 'builtin', id: entry.id };
  const topLevel = { ...entry };
  delete topLevel.parentId;
  return topLevel;
};

const insertAt = (
  sections: readonly SidebarSectionEntry[],
  index: number,
  entries: readonly SidebarSectionEntry[],
): SidebarSectionEntry[] => [...sections.slice(0, index), ...entries, ...sections.slice(index)];

/** A section that can be placed under another: not Projects, and not one that already holds children (one level). */
const canPlaceUnder = (sections: readonly SidebarSectionEntry[], entry: SidebarSectionEntry): boolean => (
  !(entry.kind === 'builtin' && entry.id === 'projects') && childrenOf(sections, entry.id).length === 0
);

/**
 * The list after one section is dropped on another. A parent moves with its
 * children because they are entries placed after it. A move that cannot be
 * placed (into itself, into a child, into Projects, under a section that
 * already holds children, or one level too deep) returns the list as it was.
 */
export const applySectionDrop = (
  sections: readonly SidebarSectionEntry[],
  activeId: string,
  overId: string,
  intent: SectionDropIntent,
): readonly SidebarSectionEntry[] => {
  if (activeId === overId) return sections;
  const active = sections.find((entry) => entry.id === activeId);
  const over = sections.find((entry) => entry.id === overId);
  if (!active || !over) return sections;
  // A parent dropped among its own children would become its own sibling.
  if (over.parentId === activeId) return sections;
  const subtree = [active, ...childrenOf(sections, activeId)];
  const rest = sections.filter((entry) => !subtree.includes(entry));

  if (intent === 'nest') {
    if (over.parentId !== undefined || !canParentSections(over)) return sections;
    // One level: a section that holds children cannot become a child itself.
    if (!canPlaceUnder(sections, active)) return sections;
    const children = childrenOf(rest, overId);
    const last = children[children.length - 1];
    const at = last ? rest.indexOf(last) + 1 : rest.indexOf(over) + 1;
    return insertAt(rest, at, [withParent(active, overId), ...subtree.slice(1)]);
  }

  if (intent === 'out') {
    if (over.parentId === undefined) return sections;
    const parentId = over.parentId;
    const parentChildren = childrenOf(rest, parentId);
    const last = parentChildren[parentChildren.length - 1];
    const at = last ? rest.indexOf(last) + 1 : rest.findIndex((entry) => entry.id === parentId) + 1;
    if (at <= 0) return sections;
    return insertAt(rest, at, [liftSection(active), ...subtree.slice(1)]);
  }

  // `keep`: the dropped place, at the level of the row it was dropped on.
  const at = sections.indexOf(over);
  if (at < 0) return sections;
  if (over.parentId !== undefined && !canPlaceUnder(sections, active)) return sections;
  const moved = over.parentId === undefined ? liftSection(active) : withParent(active, over.parentId);
  return insertAt(rest, Math.min(at, rest.length), [moved, ...subtree.slice(1)]);
};

/**
 * The list with a section placed under `parentId`, or lifted to the top level
 * right after its parent's group. The row menu and a drag share this, so the
 * two cannot disagree.
 */
export const applySectionParent = (
  sections: readonly SidebarSectionEntry[],
  id: string,
  parentId: string | undefined,
): readonly SidebarSectionEntry[] => {
  if (parentId !== undefined) return applySectionDrop(sections, id, parentId, 'nest');
  const active = sections.find((entry) => entry.id === id);
  if (!active || active.parentId === undefined) return sections;
  const parentIdOfActive = active.parentId;
  const siblings = childrenOf(sections, parentIdOfActive).filter((entry) => entry.id !== id);
  const sibling = siblings[siblings.length - 1];
  if (sibling) return applySectionDrop(sections, id, sibling.id, 'out');
  const rest = sections.filter((entry) => entry !== active);
  const at = rest.findIndex((entry) => entry.id === parentIdOfActive) + 1;
  return insertAt(rest, at, [liftSection(active)]);
};

/** The section whose children the menu offers to move a child under, by its place in the list. */
export const nearestParentSection = (
  sections: readonly SidebarSectionEntry[],
  id: string,
): SidebarSectionEntry | undefined => {
  const index = sections.findIndex((entry) => entry.id === id);
  if (index < 0) return undefined;
  for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
    const entry = sections[candidate];
    if (entry && entry.parentId === undefined && canParentSections(entry)) return entry;
  }
  return undefined;
};
