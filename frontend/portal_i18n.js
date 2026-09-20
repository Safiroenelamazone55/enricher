/* Portal del cliente — idiomas: ES (base), EN (EE. UU.), DE (Suiza), PT.
   El portal se escribe en español; aquí se traduce el DOM por frases exactas y patrones. */
(function () {
  'use strict';
  const LANGS = { es: { code: 'ES', name: 'Español', locale: 'es-ES' }, en: { code: 'EN', name: 'English', locale: 'en-US' }, de: { code: 'DE', name: 'Deutsch', locale: 'de-CH' }, pt: { code: 'PT', name: 'Português', locale: 'pt-BR' } };
  // [es, en, de, pt]
  const X = [
    ['Portal del cliente', 'Client portal', 'Kundenportal', 'Portal do cliente'],
    ['Ingresa con el correo y la contraseña que te asignamos.', 'Sign in with the email and password we assigned to you.', 'Melden Sie sich mit der zugewiesenen E-Mail-Adresse und dem Passwort an.', 'Entre com o e-mail e a senha que atribuímos a você.'],
    ['Correo electrónico', 'Email address', 'E-Mail-Adresse', 'E-mail'],
    ['Contraseña', 'Password', 'Passwort', 'Senha'],
    ['Ingresar', 'Sign in', 'Anmelden', 'Entrar'],
    ['Ingresando…', 'Signing in…', 'Anmeldung…', 'Entrando…'],
    ['¿Olvidaste tu contraseña?', 'Forgot your password?', 'Passwort vergessen?', 'Esqueceu a senha?'],
    ['Recuperar contraseña', 'Reset password', 'Passwort zurücksetzen', 'Recuperar senha'],
    ['Te enviaremos un código de verificación a tu correo.', "We'll send a verification code to your email.", 'Wir senden Ihnen einen Bestätigungscode per E-Mail.', 'Enviaremos um código de verificação para o seu e-mail.'],
    ['Escribe el código que te llegó y elige una nueva contraseña (mínimo 10 caracteres).', 'Enter the code you received and choose a new password (minimum 10 characters).', 'Geben Sie den erhaltenen Code ein und wählen Sie ein neues Passwort (mindestens 10 Zeichen).', 'Digite o código recebido e escolha uma nova senha (mínimo de 10 caracteres).'],
    ['Enviar código', 'Send code', 'Code senden', 'Enviar código'],
    ['Código de 6 dígitos', '6-digit code', '6-stelliger Code', 'Código de 6 dígitos'],
    ['Si el correo tiene acceso, te enviamos un código. Revisa también spam.', 'If the email has access, we sent you a code. Check your spam folder too.', 'Wenn die E-Mail-Adresse Zugang hat, haben wir Ihnen einen Code gesendet. Prüfen Sie auch den Spam-Ordner.', 'Se o e-mail tiver acesso, enviamos um código. Verifique também o spam.'],
    ['Contraseña actualizada. Ya puedes ingresar.', 'Password updated. You can now sign in.', 'Passwort aktualisiert. Sie können sich jetzt anmelden.', 'Senha atualizada. Você já pode entrar.'],
    ['Cambiar contraseña', 'Change password', 'Passwort ändern', 'Alterar senha'],
    ['Mínimo 10 caracteres.', 'Minimum 10 characters.', 'Mindestens 10 Zeichen.', 'Mínimo de 10 caracteres.'],
    ['Las contraseñas nuevas no coinciden', "The new passwords don't match", 'Die neuen Passwörter stimmen nicht überein', 'As novas senhas não coincidem'],
    ['Nueva contraseña', 'New password', 'Neues Passwort', 'Nova senha'],
    ['Contraseña actual', 'Current password', 'Aktuelles Passwort', 'Senha atual'],
    ['Repite la nueva contraseña', 'Repeat the new password', 'Neues Passwort wiederholen', 'Repita a nova senha'],
    ['Guardar', 'Save', 'Speichern', 'Salvar'],
    ['Volver', 'Back', 'Zurück', 'Voltar'],
    ['Cerrar sesión', 'Sign out', 'Abmelden', 'Sair'],
    ['Idioma', 'Language', 'Sprache', 'Idioma'],
    ['Correo o contraseña incorrectos', 'Incorrect email or password', 'E-Mail oder Passwort falsch', 'E-mail ou senha incorretos'],
    ['Cuenta bloqueada temporalmente por intentos fallidos. Prueba en unos minutos.', 'Account temporarily locked after failed attempts. Try again in a few minutes.', 'Konto nach fehlgeschlagenen Versuchen vorübergehend gesperrt. Versuchen Sie es in einigen Minuten erneut.', 'Conta bloqueada temporariamente por tentativas falhas. Tente novamente em alguns minutos.'],
    ['Demasiados intentos. Espera unos minutos.', 'Too many attempts. Please wait a few minutes.', 'Zu viele Versuche. Bitte warten Sie einige Minuten.', 'Muitas tentativas. Aguarde alguns minutos.'],
    ['Código incorrecto o vencido', 'Incorrect or expired code', 'Code falsch oder abgelaufen', 'Código incorreto ou expirado'],
    ['La nueva contraseña debe tener al menos 10 caracteres', 'The new password must be at least 10 characters', 'Das neue Passwort muss mindestens 10 Zeichen haben', 'A nova senha deve ter pelo menos 10 caracteres'],
    ['La contraseña actual no es correcta', 'The current password is incorrect', 'Das aktuelle Passwort ist falsch', 'A senha atual não está correta'],
    ['Elige una contraseña distinta a la actual', 'Choose a password different from the current one', 'Wählen Sie ein anderes Passwort als das aktuelle', 'Escolha uma senha diferente da atual'],
    // resumen semanal / cómo trabajamos
    ['Esta semana', 'This week', 'Diese Woche', 'Esta semana'],
    ['Semana', 'Week', 'Woche', 'Semana'], ['Mes', 'Month', 'Monat', 'Mês'],
    ['Respuestas', 'Replies', 'Antworten', 'Respostas'],
    ['Toques realizados', 'Touches made', 'Durchgeführte Kontakte', 'Toques realizados'],
    ['Mensaje de tu equipo', 'Message from your team', 'Nachricht von Ihrem Team', 'Mensagem da sua equipe'],
    ['Ver mensajes anteriores', 'View previous messages', 'Frühere Nachrichten anzeigen', 'Ver mensagens anteriores'],
    ['Cómo trabajamos', 'How we work', 'So arbeiten wir', 'Como trabalhamos'],
    ['Ver todas las secuencias →', 'View all sequences →', 'Alle Sequenzen anzeigen →', 'Ver todas as sequências →'],
    ['Ver detalle ▾', 'Show details ▾', 'Details anzeigen ▾', 'Ver detalhes ▾'], ['Ocultar detalle ▴', 'Hide details ▴', 'Details ausblenden ▴', 'Ocultar detalhes ▴'],
    ['Activa', 'Active', 'Aktiv', 'Ativa'],
    ['Visita al perfil de LinkedIn', 'LinkedIn profile visit', 'LinkedIn-Profilbesuch', 'Visita ao perfil do LinkedIn'],
    ['Invitación de LinkedIn', 'LinkedIn invitation', 'LinkedIn-Einladung', 'Convite do LinkedIn'],
    ['InMail de LinkedIn', 'LinkedIn InMail', 'LinkedIn-InMail', 'InMail do LinkedIn'],
    ['Comentario en una publicación', 'Comment on a post', 'Kommentar zu einem Beitrag', 'Comentário em uma publicação'],
    ['Mensaje de LinkedIn', 'LinkedIn message', 'LinkedIn-Nachricht', 'Mensagem do LinkedIn'],
    ['Email inicial', 'Initial email', 'Erste E-Mail', 'E-mail inicial'], ['Email de cierre', 'Closing email', 'Abschluss-E-Mail', 'E-mail de encerramento'],
    ['Llamada por WhatsApp', 'WhatsApp call', 'WhatsApp-Anruf', 'Ligação por WhatsApp'],
    ['Tarea de seguimiento', 'Follow-up task', 'Nachverfolgungsaufgabe', 'Tarefa de acompanhamento'],
    ['Contactos', 'Contacts', 'Kontakte', 'Contatos'],
    ['Completadas', 'Completed', 'Abgeschlossen', 'Concluídas'],
    // aviso de contraseña
    ['Protege tu cuenta', 'Protect your account', 'Schützen Sie Ihr Konto', 'Proteja sua conta'],
    ['Entraste con una contraseña temporal. Te recomendamos crear la tuya propia cuando puedas.', 'You signed in with a temporary password. We recommend creating your own when you can.', 'Sie haben sich mit einem temporären Passwort angemeldet. Wir empfehlen, bei Gelegenheit ein eigenes zu erstellen.', 'Você entrou com uma senha temporária. Recomendamos criar a sua quando puder.'],
    ['Crear mi contraseña', 'Create my password', 'Mein Passwort erstellen', 'Criar minha senha'],
    ['Recordármelo más tarde', 'Remind me later', 'Später erinnern', 'Lembrar mais tarde'],
    ['Omitir y seguir', 'Skip and continue', 'Überspringen und fortfahren', 'Pular e continuar'],
    ['Cerrar', 'Close', 'Schließen', 'Fechar'],
    // nav / secciones
    ['Resumen', 'Overview', 'Übersicht', 'Resumo'],
    ['Empresas', 'Companies', 'Unternehmen', 'Empresas'],
    ['Contactos', 'Contacts', 'Kontakte', 'Contatos'],
    ['Secuencias', 'Sequences', 'Sequenzen', 'Sequências'],
    ['Actividad', 'Activity', 'Aktivität', 'Atividade'],
    ['Actividad en vivo', 'Live activity', 'Live-Aktivität', 'Atividade ao vivo'],
    ['Actividad reciente', 'Recent activity', 'Letzte Aktivität', 'Atividade recente'],
    ['En vivo', 'Live', 'Live', 'Ao vivo'],
    ['Cargando…', 'Loading…', 'Wird geladen…', 'Carregando…'],
    ['Últimas respuestas', 'Latest replies', 'Letzte Antworten', 'Últimas respostas'],
    ['Próximas reuniones', 'Upcoming meetings', 'Nächste Meetings', 'Próximas reuniões'],
    ['Señales positivas por convertir', 'Positive signals to convert', 'Positive Signale zur Umsetzung', 'Sinais positivos a converter'],
    ['Aún sin respuestas', 'No replies yet', 'Noch keine Antworten', 'Ainda sem respostas'],
    ['Ninguna reunión programada todavía', 'No meetings scheduled yet', 'Noch keine Meetings geplant', 'Nenhuma reunião agendada ainda'],
    ['Sin señales pendientes', 'No pending signals', 'Keine offenen Signale', 'Sem sinais pendentes'],
    ['Todas las secuencias', 'All sequences', 'Alle Sequenzen', 'Todas as sequências'],
    ['7 días', '7 days', '7 Tage', '7 dias'], ['30 días', '30 days', '30 Tage', '30 dias'],
    ['Este mes', 'This month', 'Dieser Monat', 'Este mês'], ['Trimestre', 'Quarter', 'Quartal', 'Trimestre'],
    // KPIs
    ['Contactos alcanzados', 'Contacts reached', 'Erreichte Kontakte', 'Contatos alcançados'],
    ['Tasa de respuesta', 'Response rate', 'Antwortrate', 'Taxa de resposta'],
    ['Aceptación LinkedIn', 'LinkedIn acceptance', 'LinkedIn-Annahme', 'Aceitação no LinkedIn'],
    ['Emails enviados', 'Emails sent', 'Gesendete E-Mails', 'E-mails enviados'],
    ['Apertura email', 'Email open rate', 'E-Mail-Öffnungsrate', 'Abertura de e-mail'],
    ['Reuniones agendadas', 'Meetings booked', 'Vereinbarte Meetings', 'Reuniões agendadas'],
    ['estimada', 'estimated', 'geschätzt', 'estimada'],
    ['sin rebotes', 'no bounces', 'keine Bounces', 'sem devoluções'],
    ['ninguna programada', 'none scheduled', 'keine geplant', 'nenhuma agendada'],
    // gráficos y tablas
    ['Actividad por canal', 'Activity by channel', 'Aktivität nach Kanal', 'Atividade por canal'],
    ['Diario', 'Daily', 'Täglich', 'Diário'], ['Semanal', 'Weekly', 'Wöchentlich', 'Semanal'],
    ['Embudo', 'Funnel', 'Trichter', 'Funil'],
    ['Enrolados', 'Enrolled', 'Aufgenommen', 'Inscritos'], ['Contactados', 'Contacted', 'Kontaktiert', 'Contatados'],
    ['Respondieron', 'Replied', 'Geantwortet', 'Responderam'], ['Reunión', 'Meeting', 'Meeting', 'Reunião'],
    ['Toques por canal', 'Touches by channel', 'Kontakte nach Kanal', 'Toques por canal'],
    ['Total', 'Total', 'Gesamt', 'Total'],
    ['Países contactados', 'Countries contacted', 'Kontaktierte Länder', 'Países contatados'],
    ['Respuesta por canal', 'Response by channel', 'Antworten nach Kanal', 'Resposta por canal'],
    ['Canal', 'Channel', 'Kanal', 'Canal'], ['Tasa', 'Rate', 'Rate', 'Taxa'],
    ['Rendimiento por secuencia', 'Performance by sequence', 'Leistung pro Sequenz', 'Desempenho por sequência'],
    ['Secuencia', 'Sequence', 'Sequenz', 'Sequência'],
    ['Enrol.', 'Enrolled', 'Aufgen.', 'Inscr.'], ['Contact.', 'Contacted', 'Kontakt.', 'Contat.'],
    ['Resp.', 'Replies', 'Antw.', 'Resp.'], ['Reun.', 'Mtgs', 'Meet.', 'Reun.'],
    ['Sin actividad todavía', 'No activity yet', 'Noch keine Aktivität', 'Sem atividade ainda'],
    ['Sin empresas', 'No companies', 'Keine Unternehmen', 'Sem empresas'],
    ['Empresa', 'Company', 'Unternehmen', 'Empresa'], ['Sector', 'Industry', 'Branche', 'Setor'],
    ['Estado', 'Status', 'Status', 'Status'], ['Nota', 'Note', 'Notiz', 'Nota'],
    ['Sin contactos', 'No contacts', 'Keine Kontakte', 'Sem contatos'],
    ['Contacto', 'Contact', 'Kontakt', 'Contato'], ['Cargo', 'Job title', 'Position', 'Cargo'],
    ['Último contacto', 'Last contact', 'Letzter Kontakt', 'Último contato'],
    ['Sin secuencias', 'No sequences', 'Keine Sequenzen', 'Sem sequências'],
    ['En curso', 'In progress', 'Laufend', 'Em andamento'], ['Completadas', 'Completed', 'Abgeschlossen', 'Concluídas'],
    ['Buscar empresa…', 'Search company…', 'Unternehmen suchen…', 'Buscar empresa…'],
    ['Buscar contacto o empresa…', 'Search contact or company…', 'Kontakt oder Unternehmen suchen…', 'Buscar contato ou empresa…'],
    ['✕ quitar filtro de empresa', '✕ clear company filter', '✕ Unternehmensfilter entfernen', '✕ remover filtro de empresa'],
    // estados
    ['Respondió', 'Replied', 'Hat geantwortet', 'Respondeu'], ['Interesado', 'Interested', 'Interessiert', 'Interessado'],
    ['Más adelante', 'Later', 'Später', 'Mais tarde'], ['Derivó a otro', 'Referred to someone else', 'An andere Person verwiesen', 'Encaminhou a outra pessoa'],
    ['No es la persona', 'Not the right person', 'Nicht die richtige Person', 'Não é a pessoa certa'], ['No interesado', 'Not interested', 'Nicht interessiert', 'Sem interesse'],
    ['No califica', "Doesn't qualify", 'Nicht qualifiziert', 'Não qualifica'], ['No contactar', 'Do not contact', 'Nicht kontaktieren', 'Não contatar'],
    ['En seguimiento', 'In follow-up', 'In Nachverfolgung', 'Em acompanhamento'], ['En pausa', 'Paused', 'Pausiert', 'Em pausa'],
    ['Pendiente', 'Pending', 'Ausstehend', 'Pendente'], ['Reunión agendada', 'Meeting booked', 'Meeting vereinbart', 'Reunião agendada'],
    ['Secuencia completada', 'Sequence completed', 'Sequenz abgeschlossen', 'Sequência concluída'],
    ['Activa', 'Active', 'Aktiv', 'Ativa'],
    // actividad
    ['Aceptó la invitación de LinkedIn', 'Accepted the LinkedIn invitation', 'Hat die LinkedIn-Einladung angenommen', 'Aceitou o convite do LinkedIn'],
    ['Invitación de LinkedIn enviada', 'LinkedIn invitation sent', 'LinkedIn-Einladung gesendet', 'Convite do LinkedIn enviado'],
    ['Visita al perfil de LinkedIn', 'LinkedIn profile visit', 'LinkedIn-Profilbesuch', 'Visita ao perfil do LinkedIn'],
    ['Mensaje de LinkedIn enviado', 'LinkedIn message sent', 'LinkedIn-Nachricht gesendet', 'Mensagem do LinkedIn enviada'],
    ['Contacto por LinkedIn', 'LinkedIn outreach', 'LinkedIn-Kontakt', 'Contato pelo LinkedIn'],
    ['Llamada realizada', 'Call made', 'Anruf getätigt', 'Ligação realizada'],
    ['Email enviado', 'Email sent', 'E-Mail gesendet', 'E-mail enviado'],
    ['Mensaje de WhatsApp', 'WhatsApp message', 'WhatsApp-Nachricht', 'Mensagem de WhatsApp'],
    ['Seguimiento realizado', 'Follow-up done', 'Nachverfolgung erledigt', 'Acompanhamento realizado'],
    ['ahora', 'now', 'jetzt', 'agora'],
    // canales
    ['Llamada', 'Call', 'Anruf', 'Ligação'],
    ['WhatsApp · mensajes', 'WhatsApp · messages', 'WhatsApp · Nachrichten', 'WhatsApp · mensagens'],
    ['WhatsApp · llamadas', 'WhatsApp · calls', 'WhatsApp · Anrufe', 'WhatsApp · ligações'],
    ['Otros / tareas', 'Other / tasks', 'Sonstiges / Aufgaben', 'Outros / tarefas'],
    ['Respuesta', 'Reply', 'Antwort', 'Resposta'], ['Seguimiento', 'Follow-up', 'Nachverfolgung', 'Acompanhamento'],
    // chat
    ['Chat rápido', 'Quick chat', 'Schnellchat', 'Chat rápido'],
    ['Chat con tu equipo', 'Chat with your team', 'Chat mit Ihrem Team', 'Chat com a sua equipe'],
    ['Enviar', 'Send', 'Senden', 'Enviar'],
    ['Escribe un mensaje…', 'Type a message…', 'Nachricht eingeben…', 'Digite uma mensagem…'],
    ['Adjuntar foto o archivo', 'Attach photo or file', 'Foto oder Datei anhängen', 'Anexar foto ou arquivo'],
    ['Escríbenos aquí cualquier duda. Te respondemos lo antes posible.', "Write to us here with any question. We'll reply as soon as possible.", 'Schreiben Sie uns hier bei Fragen. Wir antworten so bald wie möglich.', 'Escreva aqui qualquer dúvida. Responderemos o mais rápido possível.'],
    ['Máximo 5 archivos por mensaje', 'Maximum 5 files per message', 'Maximal 5 Dateien pro Nachricht', 'Máximo de 5 arquivos por mensagem'],
    ['Equipo', 'Team', 'Team', 'Equipe'],
  ];
  const IDX = { es: 0, en: 1, de: 2, pt: 3 };
  const EX = { en: new Map(), de: new Map(), pt: new Map() };
  X.forEach(r => { EX.en.set(r[0], r[1]); EX.de.set(r[0], r[2]); EX.pt.set(r[0], r[3]); });
  // patrones (subcadenas / regex) [regex, en, de, pt]
  const R = [
    [/(\d+) toques en total/, '$1 touches in total', '$1 Kontakte insgesamt', '$1 toques no total'],
    [/(\d+) respondieron/, '$1 replied', '$1 haben geantwortet', '$1 responderam'],
    [/(\d+) de (\d+) invitaciones/, '$1 of $2 invitations', '$1 von $2 Einladungen', '$1 de $2 convites'],
    [/(\d+) rebotados/, '$1 bounced', '$1 zurückgewiesen', '$1 devolvidos'],
    [/sobre (\d+) envíos/, 'based on $1 emails', 'bei $1 Sendungen', 'sobre $1 envios'],
    [/(\d+) próximas?/, '$1 upcoming', '$1 anstehend', '$1 próximas'],
    [/ vs\. período anterior/, ' vs. previous period', ' ggü. Vorperiode', ' vs. período anterior'],
    [/^Agendada el /, 'Booked on ', 'Vereinbart am ', 'Agendada em '],
    [/hace (\d+) min/, '$1 min ago', 'vor $1 Min.', 'há $1 min'],
    [/hace (\d+) h/, '$1 h ago', 'vor $1 Std.', 'há $1 h'],
    [/respondió /, 'replied ', 'antwortete ', 'respondeu '],
    [/paso (\d+)/, 'step $1', 'Schritt $1', 'passo $1'],
    [/^En vivo · actualizado/, 'Live · updated', 'Live · aktualisiert', 'Ao vivo · atualizado'],
    [/^Tú · /, 'You · ', 'Sie · ', 'Você · '],
    [/^Enviar$/, 'Send', 'Senden', 'Enviar'],
    [/ vs\. semana anterior/, ' vs. previous week', ' ggü. Vorwoche', ' vs. semana anterior'],
    [/ vs\. mes anterior/, ' vs. previous month', ' ggü. Vormonat', ' vs. mês anterior'],
    [/(\d+) contactos alcanzados/, '$1 contacts reached', '$1 erreichte Kontakte', '$1 contatos alcançados'],
    [/(\d+) respuestas/, '$1 replies', '$1 Antworten', '$1 respostas'],
    [/(\d+) reuniones agendadas/, '$1 meetings booked', '$1 vereinbarte Meetings', '$1 reuniões agendadas'],
    [/(\d+) reunión agendada/, '$1 meeting booked', '$1 vereinbartes Meeting', '$1 reunião agendada'],
    [/(\d+) completados/, '$1 completed', '$1 abgeschlossen', '$1 concluídos'],
    [/(\d+) en este paso/, '$1 in this step', '$1 in diesem Schritt', '$1 nesta etapa'],
    [/^Día (\d+)$/, 'Day $1', 'Tag $1', 'Dia $1'],
    [/(\d+) contactos$/, '$1 contacts', '$1 Kontakte', '$1 contatos'],
  ];
  let lang = 'es';
  try { lang = localStorage.getItem('pt_lang') || ''; } catch (e) {}
  if (!LANGS[lang]) { const n = (navigator.language || 'es').slice(0, 2).toLowerCase(); lang = n === 'es' ? 'es' : n === 'pt' ? 'pt' : (n === 'de' || n === 'fr' || n === 'it') ? 'de' : 'en'; }
  function tx(s) {
    if (lang === 'es' || !s) return s;
    const t = s.trim(); if (!t) return s;
    const hit = EX[lang].get(t);
    if (hit) return s.replace(t, hit);
    let out = s;
    for (const r of R) { const to = r[IDX[lang]]; out = out.replace(r[0], to); }
    return out;
  }
  function walk(root) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: n => (n.parentNode && /^(SCRIPT|STYLE|CANVAS)$/.test(n.parentNode.nodeName)) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
    const nodes = []; while (w.nextNode()) nodes.push(w.currentNode);
    nodes.forEach(n => { const v = tx(n.nodeValue); if (v !== n.nodeValue) n.nodeValue = v; });
    root.querySelectorAll('[placeholder],[title],[alt]').forEach(el => ['placeholder', 'title', 'alt'].forEach(a => { const v = el.getAttribute(a); if (v) { const t = tx(v); if (t !== v) el.setAttribute(a, t); } }));
  }
  let obs = null, busy = false, pend = 0;
  function run(root) { if (busy) return; busy = true; try { walk(root); } finally { busy = false; } }
  function observe(root) {
    if (obs) obs.disconnect();
    obs = new MutationObserver(() => { if (busy || pend) return; pend = setTimeout(() => { pend = 0; if (obs) obs.disconnect(); run(root); obs.observe(root, { childList: true, subtree: true }); }, 0); });
    run(root); obs.observe(root, { childList: true, subtree: true });
  }
  function set(l, cb) { if (!LANGS[l]) return; lang = l; try { localStorage.setItem('pt_lang', l); } catch (e) {} document.documentElement.lang = l; if (cb) cb(); }
  document.documentElement.lang = lang;
  window.PT_I18N = { LANGS, get lang() { return lang; }, t: tx, set, observe, locale: () => LANGS[lang].locale };
})();
