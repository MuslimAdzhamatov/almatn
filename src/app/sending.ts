import type { Images, OutgoingPicture } from './images.js';
import type { LearningStore, NotifierPicture, SendResult } from './ports.js';

// Общее для всех отправок планировщика: картинки для Notifier, кэш file_id, 403 → blockedAt.

export interface SendingDeps {
  store: Pick<LearningStore, 'markDeliverySent' | 'setBlocked'>;
  images: Images;
  reportError: (err: unknown, context: Record<string, unknown>) => void;
}

export const toNotifier = (pictures: readonly OutgoingPicture[]): NotifierPicture[] =>
  pictures.map(({ fileId, png, lineStart, lineEnd }) => ({ fileId, png, lineStart, lineEnd }));

/** file_id только что загруженных картинок — в кэш вырезок. */
export async function rememberPictures(
  images: Images,
  textId: number,
  pictures: readonly OutgoingPicture[],
  result: SendResult,
): Promise<void> {
  if (!result.ok) return;
  await images.remember(
    textId,
    pictures.flatMap((picture, index) => {
      const fileId = result.fileIds[index];
      return picture.png && fileId ? [{ cacheKey: picture.cacheKey, fileId }] : [];
    }),
  );
}

/**
 * Результат отправки с записью в журнале: успех — отметка и кэш, 403 — пользователь заблокировал бота,
 * иначе — ошибка в лог. true — сообщение дошло.
 */
export async function settleSend(
  { store, images, reportError }: SendingDeps,
  target: { userId: bigint; textId: number | null; deliveryId: number },
  result: SendResult,
  pictures: readonly OutgoingPicture[],
  now: Date,
): Promise<boolean> {
  if (result.ok) {
    await store.markDeliverySent(
      target.deliveryId,
      result.messageIds,
      result.buttonsMessageId,
      now,
    );
    if (target.textId !== null) await rememberPictures(images, target.textId, pictures, result);
    return true;
  }
  if (result.reason === 'blocked') await store.setBlocked(target.userId, now);
  else reportError(result.error, { deliveryId: target.deliveryId, textId: target.textId });
  return false;
}
