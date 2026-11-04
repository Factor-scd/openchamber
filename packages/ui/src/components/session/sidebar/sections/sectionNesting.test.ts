import { describe, expect, test } from 'bun:test';
import { EMPTY_SIDEBAR_SECTION_FILTER, type SidebarSectionEntry } from '@/lib/sidebarSections';
import { applySectionDrop, applySectionParent, nearestParentSection } from './sectionNesting';

const custom = (id: string, parentId?: string): SidebarSectionEntry => ({
  kind: 'custom', id, name: id, grouping: parentId ? 'time' : 'section', filter: EMPTY_SIDEBAR_SECTION_FILTER, claims: false, hideWhenEmpty: true,
  ...(parentId ? { parentId } : {}),
});

const shape = (sections: readonly SidebarSectionEntry[]): Array<[string, string | undefined]> => (
  sections.map((entry) => [entry.id, entry.parentId])
);

describe('applySectionDrop', () => {
  test('nest puts the section last under the one it was dropped on', () => {
    const sections = [custom('a'), custom('b'), custom('c')];
    expect(shape(applySectionDrop(sections, 'c', 'a', 'nest'))).toEqual([
      ['a', undefined],
      ['c', 'a'],
      ['b', undefined],
    ]);
  });

  test('a section that already holds children cannot be nested, and keeps them', () => {
    const sections = [custom('p'), custom('c1', 'p'), custom('c2', 'p'), custom('q')];
    expect(applySectionDrop(sections, 'p', 'q', 'nest')).toBe(sections);
    expect(applySectionDrop(sections, 'p', 'c1', 'keep')).toBe(sections);
    // Moving it at the top level keeps the children under it.
    expect(shape(applySectionDrop(sections, 'p', 'q', 'keep'))).toEqual([
      ['q', undefined],
      ['p', undefined],
      ['c1', 'p'],
      ['c2', 'p'],
    ]);
  });

  test('Projects is never nested', () => {
    const sections = [custom('group'), { kind: 'builtin', id: 'projects' } as SidebarSectionEntry];
    expect(applySectionDrop(sections, 'projects', 'group', 'nest')).toBe(sections);
    // It can still be reordered at the top level.
    expect(shape(applySectionDrop(sections, 'projects', 'group', 'keep'))).toEqual([
      ['projects', undefined],
      ['group', undefined],
    ]);
  });

  test('out lifts a child to the top level after its parent group', () => {
    const sections = [custom('p'), custom('c1', 'p'), custom('c2', 'p'), custom('q')];
    expect(shape(applySectionDrop(sections, 'c1', 'c2', 'out'))).toEqual([
      ['p', undefined],
      ['c2', 'p'],
      ['c1', undefined],
      ['q', undefined],
    ]);
  });

  test('keep reorders siblings inside the parent', () => {
    const sections = [custom('p'), custom('c1', 'p'), custom('c2', 'p')];
    expect(shape(applySectionDrop(sections, 'c2', 'c1', 'keep'))).toEqual([
      ['p', undefined],
      ['c2', 'p'],
      ['c1', 'p'],
    ]);
  });

  test('keep reorders the top level', () => {
    const sections = [custom('a'), custom('b'), custom('c')];
    expect(shape(applySectionDrop(sections, 'c', 'a', 'keep'))).toEqual([
      ['c', undefined],
      ['a', undefined],
      ['b', undefined],
    ]);
  });

  test('a target that cannot hold a section leaves the list as it was', () => {
    const sections = [custom('p'), custom('child', 'p'), { kind: 'builtin', id: 'projects' } as SidebarSectionEntry];
    expect(applySectionDrop(sections, 'p', 'child', 'nest')).toBe(sections);
    expect(applySectionDrop(sections, 'p', 'p', 'nest')).toBe(sections);
    expect(applySectionDrop(sections, 'p', 'projects', 'nest')).toBe(sections);
    expect(applySectionDrop(sections, 'p', 'child', 'out')).toBe(sections);
    expect(applySectionDrop(sections, 'p', 'child', 'keep')).toBe(sections);
  });
});

describe('applySectionParent', () => {
  test('places a section under a parent', () => {
    const sections = [custom('group'), custom('mine')];
    expect(shape(applySectionParent(sections, 'mine', 'group'))).toEqual([
      ['group', undefined],
      ['mine', 'group'],
    ]);
  });

  test('lifts a child out to just after its parent group', () => {
    const sections = [custom('group'), custom('child', 'group'), custom('sibling', 'group'), custom('next')];
    expect(shape(applySectionParent(sections, 'child', undefined))).toEqual([
      ['group', undefined],
      ['sibling', 'group'],
      ['child', undefined],
      ['next', undefined],
    ]);
  });

  test('lifts the only child out without needing a sibling', () => {
    const sections = [custom('group'), custom('only', 'group'), custom('next')];
    expect(shape(applySectionParent(sections, 'only', undefined))).toEqual([
      ['group', undefined],
      ['only', undefined],
      ['next', undefined],
    ]);
  });
});

describe('nearestParentSection', () => {
  test('is the nearest top-level section above, never Projects', () => {
    const sections = [custom('first'), custom('group'), custom('child', 'group'), { kind: 'builtin', id: 'projects' } as SidebarSectionEntry, custom('last')];
    expect(nearestParentSection(sections, 'child')?.id).toBe('group');
    expect(nearestParentSection(sections, 'first')).toBeUndefined();
    // Projects is never a container.
    expect(nearestParentSection([{ kind: 'builtin', id: 'projects' } as SidebarSectionEntry, custom('mine')], 'mine')).toBeUndefined();
  });
});
