'use strict';

/**
 * NoticeRepository — shared read layer for the notices table.
 *
 * Used by the schedule query handler to find upcoming events without
 * duplicating query logic across multiple modules.
 *
 * Requires the `query_visible` column (added in db.js migration).
 * Notices with query_visible=0 are social noise / photos / chit-chat
 * that were deliberately filtered by triage.
 */

const { getDB } = require('../db');

class NoticeRepository {
  /**
   * @param {import('better-sqlite3').Database} [db] — optional, defaults to shared DB
   */
  constructor(db) {
    this.db = db || getDB();
  }

  /**
   * Find notices with relevance_date in [from, to].
   * Falls back to recently created notices when relevance_date is NULL.
   *
   * @param {object} opts
   * @param {string} [opts.from]            ISO date (YYYY-MM-DD), default today
   * @param {string} [opts.to]              ISO date (YYYY-MM-DD), default +7d
   * @param {string} [opts.childName]       Filter by child name in Hebrew content
   * @param {string} [opts.searchText]      Filter by arbitrary text in content
   * @param {boolean} [opts.includeDelivered] Include already-delivered notices (default true)
   * @returns {Array}
   */
  findUpcoming({ from, to, childName = null, searchText = null, includeDelivered = true } = {}) {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
    const todayIso = now.toISOString().slice(0, 10);
    const weekAhead = new Date(now);
    weekAhead.setDate(weekAhead.getDate() + 7);

    const fromDate = from || todayIso;
    const toDate   = to   || weekAhead.toISOString().slice(0, 10);
    // Fallback cutoff: notices from the past 7 days that have no date
    const cutoffMs = Date.now() - 7 * 86400000;

    let sql = `
      SELECT id, group_name, content, relevance_date, relevance_time,
             relevant_datetime, created_at, triage_decision, query_visible, primary_child
      FROM notices
      WHERE query_visible = 1
        AND dismissed = 0
        AND (
          (relevance_date IS NOT NULL AND relevance_date BETWEEN ? AND ?)
          OR (relevance_date IS NULL AND created_at > ?)
        )
    `;
    const params = [fromDate, toDate, cutoffMs];

    if (!includeDelivered) {
      sql += ` AND (posted_to_master = 0 OR posted_to_master IS NULL)`;
    }
    sql += ` ORDER BY relevance_date ASC, created_at ASC LIMIT 50`;

    let results;
    try {
      results = this.db.prepare(sql).all(...params);
    } catch (err) {
      console.error('[NoticeRepository] findUpcoming error:', err.message);
      return [];
    }

    // Hebrew content filtering (post-query, since SQLite LIKE is case-insensitive ASCII only).
    // Q2: match on primary_child (the group→child link) OR the child's name in the
    // body, so notices from a class group that never names the child still surface.
    if (childName) {
      results = results.filter(r =>
        r.primary_child === childName || (r.content && r.content.includes(childName))
      );
    }
    if (searchText) {
      results = results.filter(r => r.content && r.content.includes(searchText));
    }

    return results;
  }

  /**
   * Full-text content search, ignoring date.
   * Used as fallback when date-based query returns 0 results.
   *
   * @param {object} opts
   * @param {string} [opts.childName]   Filter by child name
   * @param {string} [opts.searchText]  Filter by text
   * @param {number} [opts.daysBack]    How far back to look (default 14)
   * @returns {Array}
   */
  findByContent({ childName = null, searchText = null, daysBack = 14 } = {}) {
    const cutoff = Date.now() - daysBack * 86400000;

    let results;
    try {
      results = this.db.prepare(`
        SELECT id, group_name, content, relevance_date, relevance_time, created_at, primary_child
        FROM notices
        WHERE query_visible = 1
          AND dismissed = 0
          AND created_at > ?
        ORDER BY created_at DESC
        LIMIT 100
      `).all(cutoff);
    } catch (err) {
      console.error('[NoticeRepository] findByContent error:', err.message);
      return [];
    }

    // Q2: match on the group→child link OR the child's name in the body.
    if (childName) results = results.filter(r => r.primary_child === childName || r.content?.includes(childName));
    if (searchText) results = results.filter(r => r.content?.includes(searchText));

    return results.slice(0, 20);
  }

  /**
   * Find pending notices not yet sent to master group.
   * @returns {Array}
   */
  findPending() {
    try {
      return this.db.prepare(`
        SELECT * FROM notices
        WHERE query_visible = 1
          AND dismissed = 0
          AND (posted_to_master = 0 OR posted_to_master IS NULL)
          AND delivery_status = 'pending'
        ORDER BY created_at ASC
      `).all();
    } catch (err) {
      console.error('[NoticeRepository] findPending error:', err.message);
      return [];
    }
  }
}

module.exports = { NoticeRepository };
