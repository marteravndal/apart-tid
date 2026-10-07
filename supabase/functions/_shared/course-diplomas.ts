import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";

export function diplomaReference(diploma: any): string {
  const year = new Date(diploma.snapshot.completed_at).toLocaleDateString("en-CA", { timeZone: "Europe/Oslo", year: "numeric" });
  return `KURS-${year}-${String(diploma.reference_no).padStart(6, "0")}`;
}

/** Render only the immutable completion snapshot, never today's employee/course data. */
export async function courseDiplomaPdf(diploma: any): Promise<Uint8Array> {
  const s = diploma.snapshot, pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const serif = await pdf.embedFont(StandardFonts.TimesRoman);
  const width = 841.89, height = 595.28, page = pdf.addPage([width, height]);
  const green = rgb(.07, .16, .13), orange = rgb(.83, .40, .22), muted = rgb(.36, .43, .39);
  pdf.setTitle(`Kursdiplom – ${s.course_title}`);
  pdf.setAuthor(s.issuer);
  pdf.setSubject(diplomaReference(diploma));
  pdf.setCreationDate(new Date(s.completed_at));
  pdf.setModificationDate(new Date(s.completed_at));
  page.drawRectangle({ x: 0, y: 0, width, height, color: rgb(.99, .99, .97) });
  page.drawRectangle({ x: 24, y: 24, width: width - 48, height: height - 48, borderColor: green, borderWidth: 1 });
  page.drawRectangle({ x: 35, y: 35, width: 5, height: height - 70, color: orange });
  const clean = (text: string) => String(text).replace(/[\r\n\t]+/g, " ").trim();
  const centered = (text: string, y: number, size: number, face = font, color = green) => {
    page.drawText(text, { x: (width - face.widthOfTextAtSize(text, size)) / 2, y, size, font: face, color });
  };
  const wrap = (text: string, size: number, face: any, maxWidth = 680): string[] => {
    const lines: string[] = []; let line = "";
    for (const word of clean(text).split(/\s+/)) {
      if (face.widthOfTextAtSize(word, size) > maxWidth) {
        if (line) { lines.push(line); line = ""; }
        for (const ch of word) {
          if (face.widthOfTextAtSize(line + ch, size) > maxWidth) { lines.push(line); line = ""; }
          line += ch;
        }
      } else if (face.widthOfTextAtSize(line ? `${line} ${word}` : word, size) > maxWidth) {
        lines.push(line); line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    if (line) lines.push(line); return lines;
  };
  const block = (text: string, y: number, preferred: number, min: number, maxLines: number, face: any, color = green) => {
    let size = preferred, lines = wrap(text, size, face);
    while (lines.length > maxLines && size > min) { size -= 1; lines = wrap(text, size, face); }
    if (lines.length > maxLines) throw new Error("Teksten er for lang for diplommalen.");
    lines.forEach((line, i) => centered(line, y - i * size * 1.25, size, face, color));
  };
  centered("APART STAVANGER AS", 524, 12, bold);
  centered("KURSDIPLOM", 466, 38, serif);
  page.drawLine({ start: { x: 365, y: 449 }, end: { x: 477, y: 449 }, thickness: 2, color: orange });
  centered("Dette bekrefter at", 422, 12, font, muted);
  block(s.employee_name, 383, 29, 18, 2, bold);
  centered("har gjennomført og bestått", 313, 12, font, muted);
  block(s.course_title, 281, 23, 14, 2, serif);
  const theoryPart = /vold.*trusler.*del\s*1/i.test(s.course_title);
  const summary = theoryPart
    ? "Kurset omfatter forståelse av vold og trusler, risikovurdering og forebygging, konfliktdempende kommunikasjon, personlig sikkerhet og oppfølging etter hendelser."
    : "Deltakeren har gjennomført kursinnholdet og bestått den tilhørende kunnskapstesten i Apart Tid.";
  block(summary, 211, 11, 10, 3, font, muted);
  const date = new Date(s.completed_at).toLocaleDateString("nb-NO", { timeZone: "Europe/Oslo", day: "2-digit", month: "2-digit", year: "numeric" });
  centered(`Fullført: ${date}    ·    Resultat: Bestått kunnskapstest`, 141, 11, bold);
  centered(`Utstedt av ${s.issuer} gjennom Apart Tid`, 115, 10, font, muted);
  centered(`Kursversjon: ${s.course_version}    ·    Diplomnummer: ${diplomaReference(diploma)}`, 96, 10, font, muted);
  if (theoryPart) centered("Diplomet dokumenterer gjennomført teoridel. Praktisk gjennomgang i Del 2 dokumenteres separat.", 58, 9, font, muted);
  return await pdf.save();
}

export async function ensureCourseDiploma(admin: any, organizationId: string, assignmentId: string): Promise<any> {
  const { data: diploma, error } = await admin.from("course_diplomas").select("*")
    .eq("organization_id", organizationId).eq("assignment_id", assignmentId).maybeSingle();
  if (error || !diploma) throw new Error("Diplomet er ikke klart ennå.");
  if (diploma.document_id) return diploma;
  const bytes = await courseDiplomaPdf(diploma);
  // Separate attempt paths avoid races with an admin deleting an older archive copy.
  const path = `${organizationId}/course-diplomas/${diploma.id}/${crypto.randomUUID()}.pdf`;
  const upload = await admin.storage.from("hr-documents").upload(path, bytes, { contentType: "application/pdf", upsert: false });
  if (upload.error) throw new Error("Diplomet kunne ikke lagres. Prøv igjen senere.");
  const finalized = await admin.rpc("finalize_course_diploma", {
    p_id: diploma.id, p_organization_id: organizationId, p_storage_path: path, p_size_bytes: bytes.length,
  });
  // Never delete on an ambiguous network error: the transaction may have committed.
  if (finalized.error) throw new Error("Diplomet kunne ikke arkiveres. Prøv igjen senere.");
  const { data: document, error: documentError } = await admin.from("hr_documents").select("storage_path")
    .eq("id", finalized.data).eq("organization_id", organizationId).single();
  if (documentError) throw new Error("Diplomet kunne ikke hentes. Prøv igjen senere.");
  if (document.storage_path !== path) await admin.storage.from("hr-documents").remove([path]);
  return { ...diploma, document_id: finalized.data };
}

/** Retry pending legacy/failed PDFs when an authorized user opens Courses or HR. */
export async function repairPendingDiplomas(admin: any, me: any): Promise<void> {
  try {
    let query = admin.from("course_diplomas").select("assignment_id").eq("organization_id", me.organization_id)
      .is("issued_at", null).order("created_at").limit(10);
    if (me.role !== "admin") query = query.eq("employee_id", me.id);
    const { data, error } = await query;
    if (error) throw error;
    for (const row of data || []) {
      try { await ensureCourseDiploma(admin, me.organization_id, row.assignment_id); }
      catch { console.error("Pending course diploma could not be generated", row.assignment_id); }
    }
  } catch { console.error("Pending course diplomas could not be loaded"); }
}
