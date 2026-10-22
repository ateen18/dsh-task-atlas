/**
 * Change feed: the signal that replaced the panel's 2.5 s poll.
 *
 * The contract that matters is small but load-bearing: a refused mutation must not
 * wake any panel, and one dead subscriber must not stop the others from being told.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createChangeFeed } from '../src/change-feed.ts'

describe('change feed', () => {
  it('starts at revision 0 with nobody listening', () => {
    const feed = createChangeFeed()
    assert.equal(feed.revision, 0)
    assert.equal(feed.size, 0)
  })

  it('notifies every subscriber with a monotonically increasing revision', () => {
    const feed = createChangeFeed()
    const seen: number[] = []
    feed.subscribe((revision) => seen.push(revision))
    feed.notify()
    feed.notify()
    assert.deepEqual(seen, [1, 2])
    assert.equal(feed.revision, 2)
  })

  it('stops delivering after unsubscribe', () => {
    const feed = createChangeFeed()
    let count = 0
    const off = feed.subscribe(() => {
      count += 1
    })
    feed.notify()
    off()
    feed.notify()
    assert.equal(count, 1)
    assert.equal(feed.size, 0)
  })

  it('keeps telling the others when one subscriber throws', () => {
    const feed = createChangeFeed()
    const seen: number[] = []
    feed.subscribe(() => {
      throw new Error('socket already gone')
    })
    feed.subscribe((revision) => seen.push(revision))
    assert.doesNotThrow(() => feed.notify())
    assert.deepEqual(seen, [1])
  })

  it('survives a subscriber unsubscribing from inside its own callback', () => {
    const feed = createChangeFeed()
    const seen: number[] = []
    const off = feed.subscribe((revision) => {
      seen.push(revision)
      off()
    })
    feed.subscribe((revision) => seen.push(revision * 10))
    feed.notify()
    feed.notify()
    // The self-unsubscribing listener runs once (revision 1); the survivor sees both
    // revisions — 1 and 2 — scaled, which is what proves iteration is over a copy.
    assert.deepEqual(seen, [1, 10, 20])
  })
})
