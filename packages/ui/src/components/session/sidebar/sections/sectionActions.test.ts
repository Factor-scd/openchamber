import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { EMPTY_SIDEBAR_SECTION_FILTER, type CustomSidebarSection, type SidebarSectionEntry } from '@/lib/sidebarSections';

mock.module('@/lib/persistence', () => ({ updateDesktopSettings: async () => {} }));

const { useSessionDisplayStore } = await import('@/stores/useSessionDisplayStore');
const {
  commitSectionDraft,
  deleteSidebarSection,
  editSection,
  setSectionParent,
  updateSectionDraft,
} = await import('./sectionActions');

const section = (id: string, parentId?: string): CustomSidebarSection => ({
  kind: 'custom', id, name: id, grouping: parentId ? 'time' : 'section', filter: EMPTY_SIDEBAR_SECTION_FILTER, claims: false, hideWhenEmpty: true,
  ...(parentId ? { parentId } : {}),
});

const setSections = (sections: SidebarSectionEntry[]): void => {
  useSessionDisplayStore.getState().setSections(sections);
};

const ids = ['parent', 'child', 'other', 'group', 'mine'];
const layout = (): Array<[string, string | undefined]> => useSessionDisplayStore.getState().sections
  .filter((entry) => ids.includes(entry.id))
  .map((entry) => [entry.id, entry.parentId]);

describe('section actions', () => {
  beforeEach(() => {
    useSessionDisplayStore.setState({ sections: [], hiddenSections: [] });
  });

  test('deleting a parent promotes its children in its place', () => {
    setSections([section('parent'), section('child', 'parent'), section('other')]);
    deleteSidebarSection('parent');
    expect(layout()).toEqual([
      ['child', undefined],
      ['other', undefined],
    ]);
  });

  test('editing a child keeps its parent', () => {
    setSections([section('parent'), section('child', 'parent')]);
    const child = useSessionDisplayStore.getState().sections.find((entry) => entry.id === 'child');
    if (!child || child.kind !== 'custom') throw new Error('the child section is missing');
    editSection(child, false);
    updateSectionDraft({ ...child, name: 'Renamed' });
    commitSectionDraft();
    const stored = useSessionDisplayStore.getState().sections.find((entry) => entry.id === 'child');
    expect(stored).toMatchObject({ kind: 'custom', name: 'Renamed', parentId: 'parent' });
  });

  test('the row menu places a section under another and lifts it back out', () => {
    setSections([section('group'), section('mine')]);
    setSectionParent('mine', 'group');
    expect(layout()).toEqual([
      ['group', undefined],
      ['mine', 'group'],
    ]);
    setSectionParent('mine', undefined);
    expect(layout()).toEqual([
      ['group', undefined],
      ['mine', undefined],
    ]);
  });
});
