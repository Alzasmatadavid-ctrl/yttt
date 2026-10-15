-- Envíos que se quedaron «en cola» al reiniciarse KAI: el mantenimiento los busca cada minuto (failInterruptedSends).
-- Índice parcial: solo contiene los mensajes en cola, que son muy pocos.
CREATE INDEX "messages_queued_idx" ON "messages" USING btree ("created_at") WHERE "messages"."status" = 'queued';
