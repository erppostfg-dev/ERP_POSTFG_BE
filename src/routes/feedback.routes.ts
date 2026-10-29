import { NextFunction, Request, Response, Router } from 'express';
import multer from 'multer';
import { FEEDBACK } from '../constants';
import { requireAuth } from '../modules/auth/auth.middleware';
import {
  Actor, addComment, addImages, addMember, createFeedback, feedbackPeople, getFeedback, ImageFile, listFeedback, listQueryOf,
  openFeedbackImage, removeImage, removeMember, updateFeedback,
} from '../modules/feedback/feedback.service';

/*
 * Feedback (2026-10-29, constants/feedback.ts, modules/feedback). Every signed-in person (page /feedback is open to all):
 *   GET   /feedback                          every item, newest first (?status=&type=&q=&mine=1)
 *   GET   /feedback/people                   active people, to add to an item
 *   GET   /feedback/:id                      one item: text, captured details, images, people, timeline, canEdit
 *   POST  /feedback                          new item (JSON, or multipart with up to 4 images in "images"), assignedToId?
 *   POST  /feedback/:id/comments             { text } (anyone)
 *   GET   /feedback/:id/images/:imageId      the image (streamed from S3)
 * Reporter, the assignee, people added to the item, developer / admin (else 403 FEEDBACK_NOT_ALLOWED):
 *   PATCH /feedback/:id                      { title?, description?, type?, severity?, status?, duplicateOfId?, assignedToId? }
 *   POST  /feedback/:id/members              { userId }       DELETE /feedback/:id/members/:userId
 *   POST  /feedback/:id/images               multipart "images" (total at most 4)
 *   POST  /feedback/:id/images/:imageId/remove   hides it (kept in S3 and the DB)
 */

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { files: FEEDBACK.MAX_IMAGES, fileSize: FEEDBACK.MAX_IMAGE_BYTES } });
const images = upload.array(FEEDBACK.FIELD_IMAGES, FEEDBACK.MAX_IMAGES);
const actor = (req: Request): Actor => ({ id: req.auth!.user.id, roles: req.auth!.roles });
const body = (req: Request) => (req.body ?? {}) as Record<string, unknown>;
const filesOf = (req: Request): ImageFile[] => ((req.files as Express.Multer.File[] | undefined) ?? []).map((f) => ({ originalname: f.originalname, buffer: f.buffer }));
const send = (fn: (req: Request) => Promise<unknown>, status = 200) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.status(status).json({ data: await fn(req) });
  } catch (err) {
    next(err);
  }
};

router.get(FEEDBACK.ROUTES.LIST, requireAuth, send((req) => listFeedback(listQueryOf(req.query as Record<string, unknown>), actor(req))));
router.get(FEEDBACK.ROUTES.PEOPLE, requireAuth, send(() => feedbackPeople()));
// Auth first, so images are only read for a signed-in person.
router.post(FEEDBACK.ROUTES.LIST, requireAuth, images, send((req) => createFeedback(body(req), filesOf(req), actor(req)), 201));
router.get(FEEDBACK.ROUTES.ONE, requireAuth, send((req) => getFeedback(req.params.id, actor(req))));
router.patch(FEEDBACK.ROUTES.ONE, requireAuth, send((req) => updateFeedback(req.params.id, body(req), actor(req))));
router.post(FEEDBACK.ROUTES.COMMENTS, requireAuth, send((req) => addComment(req.params.id, body(req), actor(req)), 201));
router.post(FEEDBACK.ROUTES.MEMBERS, requireAuth, send((req) => addMember(req.params.id, body(req), actor(req))));
router.delete(FEEDBACK.ROUTES.MEMBER, requireAuth, send((req) => removeMember(req.params.id, req.params.userId, actor(req))));
router.post(FEEDBACK.ROUTES.IMAGES, requireAuth, images, send((req) => addImages(req.params.id, filesOf(req), actor(req)), 201));
router.post(FEEDBACK.ROUTES.IMAGE_REMOVE, requireAuth, send((req) => removeImage(req.params.id, req.params.imageId, actor(req))));

router.get(FEEDBACK.ROUTES.IMAGE, requireAuth, async (req, res, next) => {
  try {
    const file = await openFeedbackImage(req.params.id, req.params.imageId);
    res.setHeader('Content-Type', file.contentType);
    if (file.length !== undefined) res.setHeader('Content-Length', String(file.length));
    res.setHeader('Content-Disposition', `inline; filename="${file.name.replace(/["\r\n]/g, '')}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    file.body.on('error', next);
    file.body.pipe(res);
  } catch (err) {
    next(err);
  }
});

export default router;
