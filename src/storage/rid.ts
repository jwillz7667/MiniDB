/**
 * A record id: the physical address of a row in a heap — a page number plus a
 * slot index within that page's slot array. B+Tree leaves store RIDs as values,
 * so an index lookup yields a RID, which the heap resolves to the actual bytes.
 */
export interface Rid {
  readonly pageNo: number;
  readonly slot: number;
}
