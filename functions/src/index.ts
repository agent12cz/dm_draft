import { initializeApp, getApps } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { buildAutomaticPickUpdate, type AutoPickDraft } from "./autoPick.js";

if (getApps().length === 0) {
  initializeApp();
}

const firestore = getFirestore();

export const autoPickExpiredTurns = onSchedule(
  {
    schedule: "every 1 minutes",
    timeZone: "UTC",
    maxInstances: 1,
    timeoutSeconds: 540,
  },
  async () => {
    const activeDrafts = await firestore.collection("drafts").where("status", "==", "drafting").get();

    for (const draftSnapshot of activeDrafts.docs) {
      try {
        const result = await firestore.runTransaction(async (transaction) => {
          const latestSnapshot = await transaction.get(draftSnapshot.ref);
          if (!latestSnapshot.exists) {
            return "missing";
          }

          const latestData = latestSnapshot.data();
          if (!latestData) {
            return "missing";
          }

          if (latestData.status !== "drafting") {
            return "changed";
          }

          const durationSeconds = Number(latestData.turnDurationSeconds);
          const turnStartedAt = latestData.turnStartedAt;
          const turnStartedAtMillis =
            typeof turnStartedAt === "object" &&
            turnStartedAt !== null &&
            "toMillis" in turnStartedAt &&
            typeof turnStartedAt.toMillis === "function"
              ? turnStartedAt.toMillis()
              : null;
          if (
            !Number.isFinite(durationSeconds) ||
            durationSeconds <= 0 ||
            turnStartedAtMillis === null ||
            turnStartedAtMillis + durationSeconds * 1000 > Date.now()
          ) {
            return "not-expired";
          }

          const pickUpdate = buildAutomaticPickUpdate({
            participants: latestData.participants ?? [],
            pickOrder: latestData.pickOrder ?? [],
            currentPickIndex: Number(latestData.currentPickIndex ?? 0),
            availableItemIds: latestData.availableItemIds ?? [],
            draftItems: latestData.draftItems ?? [],
            history: latestData.history ?? [],
            teamRanking: latestData.teamRanking,
            playerPriorities: latestData.playerPriorities,
          } as AutoPickDraft);

          if (!pickUpdate) {
            if (
              !Array.isArray(latestData.availableItemIds) ||
              latestData.availableItemIds.length === 0 ||
              Number(latestData.currentPickIndex ?? 0) >= (latestData.pickOrder?.length ?? 0)
            ) {
              transaction.update(draftSnapshot.ref, {
                status: "completed",
                turnStartedAt: FieldValue.delete(),
                updatedAt: FieldValue.serverTimestamp(),
              });
              return "completed";
            }

            return "invalid";
          }

          transaction.update(draftSnapshot.ref, {
            ...pickUpdate,
            turnStartedAt:
              pickUpdate.status === "drafting" ? FieldValue.serverTimestamp() : FieldValue.delete(),
            updatedAt: FieldValue.serverTimestamp(),
          });
          return "picked";
        });

        if (result === "invalid") {
          logger.error("Expired draft turn could not be auto-picked due to invalid draft data.", {
            draftId: draftSnapshot.id,
          });
        }
      } catch (error) {
        logger.error("Failed to auto-pick an expired draft turn.", {
          draftId: draftSnapshot.id,
          error,
        });
      }
    }
  },
);
