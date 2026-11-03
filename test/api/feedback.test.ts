import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { api, loginAs, type TestLogin } from '../helpers/auth';
import { closeDb, count, resetDb, rows } from '../helpers/db';
import { clearS3, s3Objects } from '../helpers/fake-s3';
import { covers } from '../helpers/routes';

/*
 * Feedback (2026-10-29): everyone signed in sees every item, adds items (up to 4 images) and comments; only the
 * reporter, the assignee, the people added to the item and developer / admin change it. Nothing is deleted (images are hidden).
 */
covers([
  'GET /feedback', 'GET /feedback/people', 'GET /feedback/:id', 'POST /feedback', 'PATCH /feedback/:id',
  'POST /feedback/:id/comments', 'POST /feedback/:id/members', 'DELETE /feedback/:id/members/:userId',
  'POST /feedback/:id/images', 'GET /feedback/:id/images/:imageId', 'POST /feedback/:id/images/:imageId/remove',
]);

const V = '/api/v1/feedback';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake png body')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake jpeg body')]);

let reporter: TestLogin; // operations-executive: no admin rights
let other: TestLogin; // viewer role: sees, comments, cannot change
let dev: TestLogin;

/** A problem by `who`, with images when given (multipart), else JSON. */
const create = (who: TestLogin, extra: Record<string, string> = {}, images: { buf: Buffer; name: string }[] = []) => {
  const fields = { type: 'problem', title: 'PO list is slow', description: 'Opening In Review takes 20 s', severity: 'annoying', ...extra };
  if (!images.length) return api().post(V).set('Cookie', who.cookie).send(fields);
  const req = api().post(V).set('Cookie', who.cookie);
  for (const [k, v] of Object.entries(fields)) void req.field(k, v);
  for (const i of images) void req.attach('images', i.buf, i.name);
  return req;
};

beforeEach(async () => {
  await resetDb();
  clearS3();
  reporter = await loginAs('operations-executive');
  other = await loginAs('viewer');
  dev = await loginAs('developer');
});
afterAll(closeDb);

describe('who may use it', () => {
  it('signed in only; every role (and no role) gets the page as editor in /auth/me', async () => {
    expect((await api().get(V)).status).toBe(401);
    const nobody = await loginAs(null);
    expect((await api().get(V).set('Cookie', nobody.cookie)).status).toBe(200);
    for (const who of [nobody, other, reporter]) {
      const me = await api().get('/api/v1/auth/me').set('Cookie', who.cookie).expect(200);
      expect(me.body.data.access['/feedback']).toBe('editor');
    }
  });
});

describe('adding and reading', () => {
  it('anyone adds a problem with images (S3) and the captured details; everyone sees it', async () => {
    const res = await create(other, { page: '/operations/po-review?tab=review', context: JSON.stringify({ browser: 'Chrome', lastError: { code: 'INTERNAL', requestId: 'r-1' } }) },
      [{ buf: PNG, name: 'screen.png' }, { buf: JPEG, name: 'photo.jpg' }]).expect(201);
    const item = res.body.data;
    expect(item).toMatchObject({ type: 'problem', status: 'new', severity: 'annoying', page: '/operations/po-review?tab=review', images: 2, canEdit: true });
    expect(item.context).toEqual({ browser: 'Chrome', lastError: { code: 'INTERNAL', requestId: 'r-1' } });
    expect(item.imageList.map((i: { contentType: string }) => i.contentType)).toEqual(['image/png', 'image/jpeg']);
    expect(s3Objects('feedback/').size).toBe(2);

    const list = await api().get(V).set('Cookie', reporter.cookie).expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ id: item.id, images: 2, comments: 0, canEdit: false });
    expect(list.body.data[0].reporter.id).toBe(other.userId);

    const img = await api().get(`${V}/${item.id}/images/${item.imageList[0].id}`).set('Cookie', reporter.cookie).expect(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.from(img.body as Buffer).equals(PNG)).toBe(true);
  });

  it('checks the fields (all problems at once) and the images (type from the bytes, at most 4)', async () => {
    const bad = await api().post(V).set('Cookie', other.cookie).send({ type: 'nope', title: '', description: 'x'.repeat(5001) }).expect(400);
    expect(bad.body.error.details.map((d: { field: string }) => d.field).sort()).toEqual(['description', 'title', 'type']);
    const noSeverity = await create(other, { severity: '' }).expect(400);
    expect(noSeverity.body.error.details[0].field).toBe('severity');
    // an improvement needs no severity, and keeps none
    expect((await create(other, { type: 'improvement', severity: '' }).expect(201)).body.data.severity).toBeNull();

    const notImage = await create(other, {}, [{ buf: Buffer.from('<svg onload=alert(1)>'), name: 'x.png' }]).expect(400);
    expect(notImage.body.error.code).toBe('FEEDBACK_IMAGE_TYPE');
    const five = await create(other, {}, Array.from({ length: 5 }, (_, i) => ({ buf: PNG, name: `${i}.png` }))).expect(400);
    expect(five.body.error.code).toBe('UPLOAD_REJECTED');
    expect(await count('feedback_items', 'type = ?', ['problem'])).toBe(0);
    expect(s3Objects('feedback/').size).toBe(0);
  });

  it('filters: status, type, search, mine (reported or added to); bad filters refused; unknown id 404', async () => {
    const a = (await create(reporter).expect(201)).body.data;
    await create(other, { type: 'question', severity: '', title: 'How do I export?' }).expect(201);
    const ids = async (q: string, who = reporter) => (await api().get(`${V}?${q}`).set('Cookie', who.cookie).expect(200)).body.data.map((x: { id: string }) => x.id);
    expect(await ids('type=question')).toHaveLength(1);
    expect(await ids('q=export')).toHaveLength(1);
    expect(await ids('mine=1')).toEqual([a.id]);
    await api().post(`${V}/${a.id}/members`).set('Cookie', reporter.cookie).send({ userId: other.userId }).expect(200);
    expect(await ids('mine=1', other)).toHaveLength(2);
    expect(await ids('status=new')).toHaveLength(2);
    const refused = await api().get(`${V}?status=closed&type=bug`).set('Cookie', reporter.cookie).expect(400);
    expect(refused.body.error.details.map((d: { field: string }) => d.field).sort()).toEqual(['status', 'type']);
    expect((await api().get(`${V}/999999`).set('Cookie', reporter.cookie)).status).toBe(404);
    expect((await api().get(`${V}/abc`).set('Cookie', reporter.cookie)).status).toBe(404);
  });
});

describe('who may change an item', () => {
  it('the reporter, a person added to it and a developer may; anyone else gets 403 and nothing changes', async () => {
    const item = (await create(reporter).expect(201)).body.data;
    const patch = (who: TestLogin, body: Record<string, unknown>) => api().patch(`${V}/${item.id}`).set('Cookie', who.cookie).send(body);
    expect((await patch(other, { status: 'fixed' }).expect(403)).body.error.code).toBe('FEEDBACK_NOT_ALLOWED');
    expect((await api().post(`${V}/${item.id}/members`).set('Cookie', other.cookie).send({ userId: other.userId })).status).toBe(403);
    expect((await rows<{ status: string }>('SELECT status FROM feedback_items WHERE id = ?', [item.id]))[0].status).toBe('new');

    await patch(reporter, { status: 'in_progress' }).expect(200);
    await api().post(`${V}/${item.id}/members`).set('Cookie', reporter.cookie).send({ userId: other.userId }).expect(200);
    const byMember = await patch(other, { status: 'fixed', title: 'PO list slow (fixed)' }).expect(200);
    expect(byMember.body.data).toMatchObject({ status: 'fixed', title: 'PO list slow (fixed)', canEdit: true });
    expect(byMember.body.data.updatedBy.id).toBe(other.userId);
    await patch(dev, { status: 'planned' }).expect(200);
    const admin = await loginAs('admin');
    await patch(admin, { status: 'wont_do' }).expect(200);

    // every change is a line in the timeline, by who made it
    const lines = (await api().get(`${V}/${item.id}`).set('Cookie', other.cookie).expect(200)).body.data.timeline
      .filter((t: { kind: string }) => t.kind === 'change').map((t: { text: string; by: { id: number } }) => [t.by.id, t.text]);
    expect(lines).toEqual([
      [reporter.userId, 'Status: New → Looking at it'],
      [reporter.userId, expect.stringContaining('Added Test viewer')],
      [other.userId, 'Title: "PO list is slow" → "PO list slow (fixed)"'],
      [other.userId, 'Status: Looking at it → Fixed'],
      [dev.userId, 'Status: Fixed → Planned'],
      [admin.userId, "Status: Planned → Won't do"],
    ]);

    // removed from the item = no longer allowed
    await api().delete(`${V}/${item.id}/members/${other.userId}`).set('Cookie', reporter.cookie).expect(200);
    await patch(other, { status: 'new' }).expect(403);
  });

  it('checks the change: bad values refused together; duplicate needs another existing item; nothing changed = no line', async () => {
    const first = (await create(reporter).expect(201)).body.data;
    const item = (await create(reporter, { title: 'Same thing again' }).expect(201)).body.data;
    const bad = await api().patch(`${V}/${item.id}`).set('Cookie', reporter.cookie).send({ status: 'closed', type: 'bug', title: '' }).expect(400);
    expect(bad.body.error.details.map((d: { field: string }) => d.field).sort()).toEqual(['status', 'title', 'type']);
    await api().patch(`${V}/${item.id}`).set('Cookie', reporter.cookie).send({ status: 'duplicate' }).expect(400);
    await api().patch(`${V}/${item.id}`).set('Cookie', reporter.cookie).send({ status: 'duplicate', duplicateOfId: item.id }).expect(400);
    const dup = await api().patch(`${V}/${item.id}`).set('Cookie', reporter.cookie).send({ status: 'duplicate', duplicateOfId: first.id }).expect(200);
    expect(dup.body.data).toMatchObject({ status: 'duplicate', duplicateOfId: first.id });
    expect(dup.body.data.timeline.at(-1).text).toBe(`Status: New → Duplicate of #${first.id}`);
    const before = await count('feedback_comments');
    await api().patch(`${V}/${item.id}`).set('Cookie', reporter.cookie).send({ title: 'Same thing again', status: 'duplicate', duplicateOfId: first.id }).expect(200);
    expect(await count('feedback_comments')).toBe(before);
    // leaving duplicate clears the link
    expect((await api().patch(`${V}/${item.id}`).set('Cookie', reporter.cookie).send({ status: 'new' }).expect(200)).body.data.duplicateOfId).toBeNull();
    // only active people can be added
    const off = await loginAs('viewer', { status: 'inactive' });
    expect((await api().post(`${V}/${item.id}/members`).set('Cookie', reporter.cookie).send({ userId: off.userId }).expect(400)).body.error.details[0].field).toBe('userId');
  });
});

describe('assigned to', () => {
  it('set on create or by PATCH (active people only); the assignee may change the item, sees it in Mine; every change is a line', async () => {
    const nameOf = async (id: number) => (await api().get(`${V}/people`).set('Cookie', dev.cookie).expect(200)).body.data.find((p: { id: number }) => p.id === id).name as string;
    // on create: shown with the reporter in the list and the item
    const item = (await create(reporter, { assignedToId: String(dev.userId) }).expect(201)).body.data;
    expect(item.assignedTo.id).toBe(dev.userId);
    expect(item.timeline.at(-1)).toMatchObject({ kind: 'change', text: `Assigned to ${await nameOf(dev.userId)}` });
    const listed = (await api().get(V).set('Cookie', other.cookie).expect(200)).body.data[0];
    expect(listed).toMatchObject({ reporter: { id: reporter.userId }, assignedTo: { id: dev.userId } });
    // not assigned: null, and a bad / inactive person is refused (nothing saved)
    expect((await create(reporter).expect(201)).body.data.assignedTo).toBeNull();
    const off = await loginAs('viewer', { status: 'inactive' });
    const before = await count('feedback_items');
    for (const bad of [String(off.userId), '999999', 'abc']) {
      expect((await create(reporter, { assignedToId: bad }).expect(400)).body.error.details[0].field).toBe('assignedToId');
    }
    expect(await count('feedback_items')).toBe(before);

    // the viewer may not change it until it is assigned to them; then they may, and it is in their Mine
    const patch = (who: TestLogin, body: Record<string, unknown>) => api().patch(`${V}/${item.id}`).set('Cookie', who.cookie).send(body);
    await patch(other, { assignedToId: other.userId }).expect(403);
    const mineIds = async () => (await api().get(`${V}?mine=1`).set('Cookie', other.cookie).expect(200)).body.data.map((x: { id: string }) => x.id);
    expect(await mineIds()).toEqual([]);
    const moved = await patch(reporter, { assignedToId: other.userId }).expect(200);
    expect(moved.body.data.assignedTo.id).toBe(other.userId);
    expect(moved.body.data.timeline.at(-1).text).toBe(`Assigned to: ${await nameOf(dev.userId)} → ${await nameOf(other.userId)}`);
    expect(await mineIds()).toEqual([item.id]);
    expect((await patch(other, { status: 'in_progress' }).expect(200)).body.data.canEdit).toBe(true);
    // same person again = no line; null = nobody (and the viewer loses the right to change it)
    const lines = await count('feedback_comments');
    await patch(other, { assignedToId: String(other.userId) }).expect(200);
    expect(await count('feedback_comments')).toBe(lines);
    expect((await patch(other, { assignedToId: null }).expect(200)).body.data.timeline.at(-1).text).toBe(`Assigned to: ${await nameOf(other.userId)} → —`);
    await patch(other, { status: 'new' }).expect(403);
    expect((await patch(reporter, { assignedToId: off.userId }).expect(400)).body.error.details[0].field).toBe('assignedToId');
  });
});

describe('comments, people and images', () => {
  it('anyone comments (text required); people list = active users', async () => {
    const item = (await create(reporter).expect(201)).body.data;
    await api().post(`${V}/${item.id}/comments`).set('Cookie', other.cookie).send({ text: '  ' }).expect(400);
    const res = await api().post(`${V}/${item.id}/comments`).set('Cookie', other.cookie).send({ text: 'Same for me on PO 123' }).expect(201);
    expect(res.body.data.timeline.at(-1)).toMatchObject({ kind: 'comment', text: 'Same for me on PO 123', by: { id: other.userId } });
    expect((await api().get(V).set('Cookie', other.cookie).expect(200)).body.data[0].comments).toBe(1);
    await loginAs('viewer', { status: 'inactive' });
    const people = (await api().get(`${V}/people`).set('Cookie', other.cookie).expect(200)).body.data;
    expect(people.map((p: { id: number }) => p.id).sort()).toEqual([reporter.userId, other.userId, dev.userId].sort());
  });

  it('images: added up to 4 in total by people who may change it; hidden (kept in S3 and the DB), not deleted', async () => {
    const item = (await create(reporter, {}, [{ buf: PNG, name: 'a.png' }, { buf: PNG, name: 'b.png' }]).expect(201)).body.data;
    const add = (who: TestLogin, n: number) => {
      const req = api().post(`${V}/${item.id}/images`).set('Cookie', who.cookie);
      for (let i = 0; i < n; i++) void req.attach('images', JPEG, `more${i}.jpg`);
      return req;
    };
    expect((await add(other, 1)).status).toBe(403);
    expect((await add(reporter, 3).expect(400)).body.error.code).toBe('FEEDBACK_IMAGE_LIMIT');
    expect((await add(reporter, 2).expect(201)).body.data.images).toBe(4);
    expect((await api().post(`${V}/${item.id}/images`).set('Cookie', reporter.cookie).expect(400)).body.error.code).toBe('NO_FILES_UPLOADED');

    const first = item.imageList[0].id;
    expect((await api().post(`${V}/${item.id}/images/${first}/remove`).set('Cookie', other.cookie)).status).toBe(403);
    const after = await api().post(`${V}/${item.id}/images/${first}/remove`).set('Cookie', reporter.cookie).expect(200);
    expect(after.body.data.images).toBe(3);
    expect(after.body.data.timeline.at(-1).text).toBe('Removed image a.png');
    expect((await api().get(`${V}/${item.id}/images/${first}`).set('Cookie', reporter.cookie)).status).toBe(404);
    expect(await count('feedback_images')).toBe(4);
    expect(s3Objects('feedback/').size).toBe(4);
    // room again for one more
    await add(reporter, 1).expect(201);
  });
});
