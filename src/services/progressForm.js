// Shared between the self-service /progress page and the admin
// /admin/users/:id/progress page (routes/progressRoutes.js and
// routes/adminRoutes.js) - both submit the exact same field set to their
// respective PATCH endpoint (/api/progress/me vs
// /api/progress/admin/users/:id), which accept an identical body shape
// (see LanguageDrill_ProgressStats/src/services/progressValidation.js).
// One parser here means both routes and the shared form mixin
// (views/mixins/progressForm.pug) stay in sync automatically instead of
// three copies of the same field list drifting apart.
const NUMERIC_FIELDS = [
  'xp', 'level', 'streakDays', 'totalSentences', 'totalStudyTime', 'averageAccuracy',
  'savedItemsCount', 'foldersCount', 'vocabAccuracy', 'listeningAccuracy',
  'writingAccuracy', 'youtubeAccuracy', 'dailyGoal', 'dailyGoalProgress', 'longestStreak',
];

// Turns the submitted HTML form body into the JSON body Progress Stats'
// PATCH endpoints expect. Sends every field the form has an input for,
// same "whole record" save the field's own admin.pug already does - actual
// per-field validation (range/type) happens server-side in Progress Stats,
// not here; an invalid value simply comes back as a GatewayError(400)
// that the route re-renders on the form (see routes/progressRoutes.js).
function parseProgressForm(body) {
  const update = {};

  for (const key of NUMERIC_FIELDS) {
    if (body[key] !== undefined && body[key] !== '') {
      const num = Number(body[key]);
      if (!Number.isNaN(num)) update[key] = num;
    }
  }

  if (body.badges !== undefined) {
    update.badges = body.badges.split(',').map((b) => b.trim()).filter(Boolean);
  }
  if (body.targetLanguage) {
    update.targetLanguage = body.targetLanguage.trim();
  }
  if (body.lastStudyDate !== undefined) {
    update.lastStudyDate = body.lastStudyDate ? new Date(body.lastStudyDate).toISOString() : null;
  }
  if (body.weeklyActivity !== undefined) {
    const values = Array.isArray(body.weeklyActivity) ? body.weeklyActivity : [body.weeklyActivity];
    update.weeklyActivity = values.map((v) => Number(v) || 0);
  }

  return update;
}

module.exports = { NUMERIC_FIELDS, parseProgressForm };
