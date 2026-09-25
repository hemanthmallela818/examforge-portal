import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SortableTH, Table, TBody, TD, THead, TR, compareSortValues, useSortableData } from '../../src/components/ui';

const people = [
  { id: 1, name: 'charlie', room: 'Class 10', score: 5 },
  { id: 2, name: 'Alice', room: 'Class 2', score: null },
  { id: 3, name: 'bob', room: '', score: 12 },
  { id: 4, name: 'alice', room: 'Class 2', score: 7 }
];

const accessors = { name: p => p.name, room: p => p.room, score: p => p.score };

function PeopleTable({ initialSort = null }) {
  const { sortedItems, sort, requestSort } = useSortableData(people, accessors, initialSort);
  return (
    <Table stickyHeader scrollLabel="People">
      <THead>
        <tr>
          <SortableTH sortKey="name" sort={sort} onSort={requestSort}>Name</SortableTH>
          <SortableTH sortKey="room" sort={sort} onSort={requestSort}>Room</SortableTH>
          <SortableTH sortKey="score" sort={sort} onSort={requestSort} align="right">Score</SortableTH>
        </tr>
      </THead>
      <TBody>
        {sortedItems.map(p => (
          <TR key={p.id}><TD>{p.name}</TD><TD>{p.room}</TD><TD>{p.score ?? ''}</TD></TR>
        ))}
      </TBody>
    </Table>
  );
}

const ids = () => screen.getAllByRole('row').slice(1).map(row => within(row).getAllByRole('cell')[0].textContent);
const header = name => screen.getByRole('columnheader', { name });

describe('compareSortValues', () => {
  it('collates case-insensitively and numerically', () => {
    expect(['Class 10', 'class 2', 'Class 1'].sort((a, b) => compareSortValues(a, b))).toEqual(['Class 1', 'class 2', 'Class 10']);
  });

  it('keeps empty values last in both directions', () => {
    expect([null, 3, '', 1].sort((a, b) => compareSortValues(a, b, 'asc'))).toEqual([1, 3, null, '']);
    expect([null, 3, '', 1].sort((a, b) => compareSortValues(a, b, 'desc'))).toEqual([3, 1, null, '']);
  });
});

describe('SortableTH + useSortableData', () => {
  it('keeps the incoming order and no aria-sort until a column is chosen', () => {
    render(<PeopleTable />);
    expect(ids()).toEqual(['charlie', 'Alice', 'bob', 'alice']);
    for (const name of ['Name', 'Room', 'Score']) expect(header(name).getAttribute('aria-sort')).toBeNull();
  });

  it('sorts ascending, then descending, exposing aria-sort on the active header only', async () => {
    const user = userEvent.setup();
    render(<PeopleTable />);
    await user.click(screen.getByRole('button', { name: 'Name' }));
    // Stable: equal names ("Alice"/"alice") keep their incoming order.
    expect(ids()).toEqual(['Alice', 'alice', 'bob', 'charlie']);
    expect(header('Name').getAttribute('aria-sort')).toBe('ascending');
    expect(header('Room').getAttribute('aria-sort')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Name' }));
    expect(ids()).toEqual(['charlie', 'bob', 'Alice', 'alice']);
    expect(header('Name').getAttribute('aria-sort')).toBe('descending');

    await user.click(screen.getByRole('button', { name: 'Room' }));
    expect(header('Name').getAttribute('aria-sort')).toBeNull();
    expect(header('Room').getAttribute('aria-sort')).toBe('ascending');
    // Numeric-aware ("Class 2" < "Class 10") with the blank room last.
    expect(ids()).toEqual(['Alice', 'alice', 'charlie', 'bob']);
  });

  it('is operable from the keyboard (Tab + Enter / Space)', async () => {
    const user = userEvent.setup();
    render(<PeopleTable />);
    await user.tab(); // the scrollable table region
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Name' }));
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Score' }));
    await user.keyboard('{Enter}');
    expect(header('Score').getAttribute('aria-sort')).toBe('ascending');
    expect(ids()).toEqual(['charlie', 'alice', 'bob', 'Alice']);
    await user.keyboard(' ');
    expect(header('Score').getAttribute('aria-sort')).toBe('descending');
    expect(ids()).toEqual(['bob', 'alice', 'charlie', 'Alice']);
  });

  it('accepts an initial sort and renders a sticky, labelled scroll region', () => {
    render(<PeopleTable initialSort={{ key: 'score', direction: 'desc' }} />);
    expect(header('Score').getAttribute('aria-sort')).toBe('descending');
    const region = screen.getByRole('region', { name: 'People' });
    expect(region.tabIndex).toBe(0);
    expect(region.className).toMatch(/overflow-y-auto/);
    expect(within(region).getByRole('table').className).toMatch(/\[&_thead_th\]:sticky/);
  });
});
