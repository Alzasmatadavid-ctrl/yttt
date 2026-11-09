-- KAI hace UNA sola pregunta por mensaje: la pregunta de urgencia por defecto tenía dos.
-- Solo se cambia en los negocios que la conservan tal cual (si el entrenador la personalizó, se respeta).
UPDATE "qualification_rules"
SET "question" = '¿Hay alguna fecha o motivo que te haga querer empezar ahora?', "updated_at" = now()
WHERE "key" = 'urgency' AND "question" = '¿Por qué ahora? ¿Hay alguna fecha o algo que te haga querer empezar ya?';
