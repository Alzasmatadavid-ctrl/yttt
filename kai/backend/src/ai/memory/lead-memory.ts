/**
 * Memoria a largo plazo de cada lead.
 * Guarda hechos relevantes (“tiene una boda en septiembre”, “trabaja a turnos”) para que KAI
 * pueda usarlos días después: “Teniendo en cuenta que me comentaste que tienes la boda en septiembre…”.
 * La memoria está SIEMPRE asociada a un lead y a un negocio.
 */
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../../database/client.js';
import { leadMemories } from '../../database/schema.js';
import { normalize } from '../../lib/text.js';

export type MemoryKind = 'fact' | 'event' | 'preference' | 'constraint' | 'personal';

export interface MemoryInput {
  kind: MemoryKind;
  content: string;
  importance?: number;
}

export async function listLeadMemories(businessId: string, leadId: string, limit = 20) {
  return getDb()
    .select()
    .from(leadMemories)
    .where(and(eq(leadMemories.businessId, businessId), eq(leadMemories.leadId, leadId)))
    .orderBy(desc(leadMemories.importance), desc(leadMemories.createdAt))
    .limit(limit);
}

function similar(a: string, b: string) {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const wa = new Set(na.split(' ').filter((w) => w.length > 3));
  const wb = new Set(nb.split(' ').filter((w) => w.length > 3));
  if (wa.size === 0 || wb.size === 0) return false;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.min(wa.size, wb.size) >= 0.75;
}

/** Guarda recuerdos nuevos evitando duplicados. Devuelve los que se han guardado. */
export async function saveLeadMemories(businessId: string, leadId: string, items: MemoryInput[], sourceMessageId?: string | null) {
  const clean = items
    .map((i) => ({ ...i, content: i.content.trim().slice(0, 300) }))
    .filter((i) => i.content.length >= 4)
    .slice(0, 8);
  if (clean.length === 0) return [];
  const existing = await listLeadMemories(businessId, leadId, 100);
  const saved: (typeof leadMemories.$inferSelect)[] = [];
  for (const item of clean) {
    if (existing.some((e) => similar(e.content, item.content)) || saved.some((s) => similar(s.content, item.content))) continue;
    const [row] = await getDb()
      .insert(leadMemories)
      .values({
        businessId,
        leadId,
        kind: item.kind,
        content: item.content,
        importance: Math.min(3, Math.max(1, Math.round(item.importance ?? 2))),
        sourceMessageId: sourceMessageId ?? null,
      })
      .returning();
    saved.push(row);
  }
  return saved;
}

export async function deleteLeadMemory(businessId: string, memoryId: string) {
  await getDb()
    .delete(leadMemories)
    .where(and(eq(leadMemories.businessId, businessId), eq(leadMemories.id, memoryId)));
}
