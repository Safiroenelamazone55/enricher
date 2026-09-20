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
    // reuniones y ficha
    ['Reuniones', 'Meetings', 'Meetings', 'Reuniões'],
    ['Ver calendario →', 'View calendar →', 'Kalender anzeigen →', 'Ver calendário →'],
    ['Próximas', 'Upcoming', 'Anstehend', 'Próximas'], ['Anteriores', 'Past', 'Vergangene', 'Anteriores'],
    ['Sin reuniones todavía', 'No meetings yet', 'Noch keine Meetings', 'Sem reuniões ainda'],
    ['Hoy', 'Today', 'Heute', 'Hoje'],
    ['Historial desde el primer contacto', 'History since first contact', 'Verlauf seit dem Erstkontakt', 'Histórico desde o primeiro contato'],
    ['Primer contacto', 'First contact', 'Erstkontakt', 'Primeiro contato'],
    ['Estado', 'Status', 'Status', 'Status'],
    ['Nota de tu equipo', 'Note from your team', 'Notiz Ihres Teams', 'Nota da sua equipe'],
    ['Notas de tu equipo', 'Notes from your team', 'Notizen Ihres Teams', 'Notas da sua equipe'],
    ['Para el', 'For', 'Für den', 'Para'],
    ['Fecha de la reunión', 'Meeting date', 'Meeting-Datum', 'Data da reunião'],
    ['Agendada el', 'Booked on', 'Vereinbart am', 'Agendada em'],
    ['Valor', 'Value', 'Wert', 'Valor'], ['Probabilidad', 'Probability', 'Wahrscheinlichkeit', 'Probabilidade'],
    ['Sin historial todavía', 'No history yet', 'Noch kein Verlauf', 'Sem histórico ainda'],
    ['Reunión agendada', 'Meeting booked', 'Meeting vereinbart', 'Reunião agendada'],
    ['Llamada por WhatsApp', 'WhatsApp call', 'WhatsApp-Anruf', 'Ligação por WhatsApp'],
    ['Mensaje de LinkedIn enviado', 'LinkedIn message sent', 'LinkedIn-Nachricht gesendet', 'Mensagem do LinkedIn enviada'],
    ['Ganado', 'Won', 'Gewonnen', 'Ganho'], ['Perdido', 'Lost', 'Verloren', 'Perdido'],
    ['Nuevo', 'New', 'Neu', 'Novo'], ['Contactado', 'Contacted', 'Kontaktiert', 'Contatado'],
    ['Propuesta', 'Proposal', 'Angebot', 'Proposta'], ['Negociación', 'Negotiation', 'Verhandlung', 'Negociação'],
    ['Notas y comentarios del deal', 'Deal notes and comments', 'Notizen und Kommentare zum Deal', 'Notas e comentários do deal'],
    ['Historial de la empresa', 'Company history', 'Verlauf des Unternehmens', 'Histórico da empresa'],
    ['Historial del contacto', 'Contact history', 'Verlauf des Kontakts', 'Histórico do contato'],
    ['Se agregó a', 'Added', 'Hinzugefügt:', 'Adicionado:'],
    ['Reunión con', 'Meeting with', 'Meeting mit', 'Reunião com'],
    ['Derivado por', 'Referred by', 'Empfohlen von', 'Indicado por'],
    ['Empresa', 'Company', 'Unternehmen', 'Empresa'], ['Contacto', 'Contact', 'Kontakt', 'Contato'],
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
    ['Respondió', 'Replied', 'Hat geantwortet', 'Respondeu'], ['En revisión', 'Under review', 'In Prüfung', 'Em revisão'], ['Interesado', 'Interested', 'Interessiert', 'Interessado'],
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
    [/^Contactos en la empresa \((\d+)\)$/, 'Contacts at the company ($1)', 'Kontakte im Unternehmen ($1)', 'Contatos na empresa ($1)'],
    [/^Agregado el /, 'Added on ', 'Hinzugefügt am ', 'Adicionado em '],
    [/ vs\. semana anterior/, ' vs. previous week', ' ggü. Vorwoche', ' vs. semana anterior'],
    [/ vs\. mes anterior/, ' vs. previous month', ' ggü. Vormonat', ' vs. mês anterior'],
    [/(\d+) contactos alcanzados/, '$1 contacts reached', '$1 erreichte Kontakte', '$1 contatos alcançados'],
    [/(\d+) respuestas/, '$1 replies', '$1 Antworten', '$1 respostas'],
    [/(\d+) reuniones agendadas/, '$1 meetings booked', '$1 vereinbarte Meetings', '$1 reuniões agendadas'],
    [/(\d+) reunión agendada/, '$1 meeting booked', '$1 vereinbartes Meeting', '$1 reunião agendada'],
    [/(\d+) completados/, '$1 completed', '$1 abgeschlossen', '$1 concluídos'],
    [/(\d+) en este paso/, '$1 in this step', '$1 in diesem Schritt', '$1 nesta etapa'],
    [/^Día (\d+)$/, 'Day $1', 'Tag $1', 'Dia $1'],
    [/(\d+) contactos?$/, '$1 contacts', '$1 Kontakte', '$1 contatos'],
  ];
  // ── Ajustes de calidad (inglés, alemán, portugués) ──
  // Redacción más natural (sobrescribe la traducción base)
  [
    ['Señales positivas por convertir', 'Warm leads to convert', 'Warme Kontakte zur Umsetzung', 'Contatos quentes a converter'],
    ['Toques realizados', 'Outreach touchpoints', 'Durchgeführte Kontakte', 'Contatos realizados'],
    ['Toques por canal', 'Touchpoints by channel', 'Kontakte nach Kanal', 'Contatos por canal'],
    ['Aceptación LinkedIn', 'LinkedIn acceptance rate', 'LinkedIn-Annahmequote', 'Taxa de aceitação no LinkedIn'],
    ['Más adelante', 'Follow up later', 'Später nachfassen', 'Retomar mais tarde'],
    ['Enrolados', 'In sequence', 'In Sequenz', 'Em sequência'], ['Enrol.', 'In seq.', 'In Seq.', 'Em seq.'],
    ['No califica', 'Not a fit', 'Passt nicht', 'Fora do perfil'],
    ['Seguimiento realizado', 'Follow-up completed', 'Nachverfolgung abgeschlossen', 'Acompanhamento concluído'],
    ['Cargo', 'Job title', 'Position', 'Cargo'],
    ['País', 'Country', 'Land', 'País'],
    ['Mensaje de LinkedIn', 'LinkedIn message', 'LinkedIn-Nachricht', 'Mensagem do LinkedIn'],
    ['Historial desde el primer contacto', 'History since first contact', 'Verlauf seit dem Erstkontakt', 'Histórico desde o primeiro contato'],
  ].forEach(r => { EX.en.set(r[0], r[1]); EX.de.set(r[0], r[2]); EX.pt.set(r[0], r[3]); });

  // singular / plural y frases con fecha (van ANTES de los patrones generales)
  R.unshift(
    [/(\d+) toques en total/, '$1 touchpoints in total', '$1 Kontakte insgesamt', '$1 contatos no total'],
    [/\b1 contactos?$/, '1 contact', '1 Kontakt', '1 contato'],
    [/\b1 respuestas?\b/, '1 reply', '1 Antwort', '1 resposta'],
    [/\b1 contactos? alcanzados?\b/, '1 contact reached', '1 erreichter Kontakt', '1 contato alcançado'],
    [/\b1 respondió\b/, '1 replied', '1 hat geantwortet', '1 respondeu'],
    [/\b1 completados?\b/, '1 completed', '1 abgeschlossen', '1 concluído'],
    [/^Para el /, 'For ', 'Für den ', 'Para '],
    [/hace (\d+) d[ií]as?/, '$1 d ago', 'vor $1 T.', 'há $1 d'],
  );

  // Limpieza de datos importados de LinkedIn: "Jefe de flota 3 yrs 5 mos" / "… N/A"
  const cleanTenure = s => s.replace(/\s+(?:N\/A|\d+\s*(?:yrs?|años?)(?:\s+\d+\s*(?:mos?|mes(?:es)?))?|\d+\s*(?:mos?|mes(?:es)?))\s*$/i, '');

  // Cargos y nombres de secuencias en inglés (los datos vienen en español)
  const T_DOM = { 'operaciones': 'Operations', 'transporte': 'Transport', 'flota': 'Fleet', 'flotas': 'Fleet', 'logística': 'Logistics', 'logistica': 'Logistics', 'distribución': 'Distribution', 'distribucion': 'Distribution', 'compras': 'Purchasing', 'ventas': 'Sales', 'marketing': 'Marketing', 'mantenimiento': 'Maintenance', 'planificación': 'Planning', 'planificacion': 'Planning', 'tráfico': 'Traffic', 'trafico': 'Traffic', 'producción': 'Production', 'produccion': 'Production', 'calidad': 'Quality', 'planta': 'Plant', 'tienda': 'Store', 'finanzas': 'Finance', 'exportación': 'Export', 'almacén': 'Warehouse', 'almacen': 'Warehouse', 'tecnología': 'Technology', 'comercial': 'Commercial', 'recursos humanos': 'Human Resources', 'transporte internacional': 'International Transport', 'transporte nacional': 'National Transport', 'planificación de operaciones': 'Operations Planning', 'control de operaciones': 'Operations Control', 'sección': 'Section', 'seccion': 'Section', 'área distribución': 'Distribution Area', 'area distribucion': 'Distribution Area' };
  const T_ROLE = { director: 'Director of %', directora: 'Director of %', jefe: 'Head of %', jefa: 'Head of %', responsable: '% Manager', gerente: '% Manager', gestor: '% Manager', gestora: '% Manager', técnico: '% Technician', tecnico: '% Technician', técnica: '% Technician' };
  const T_PHRASE = [
    [/\bDirector(?:a)? general\b/gi, 'General Manager'], [/\bGerente general\b/gi, 'General Manager'], [/\bConsejer[oa] delegad[oa]\b/gi, 'CEO'],
    [/\bDirector(?:a)? comercial\b/gi, 'Commercial Director'], [/\bDirector(?:a)? t[eé]cnic[oa]\b/gi, 'Technical Director'],
    [/\bGesti[oó]n de flotas?\b/gi, 'Fleet Management'], [/\bGesti[oó]n de transporte\b/gi, 'Transport Management'],
    [/\bOperaciones de log[ií]stica\b/gi, 'Logistics Operations'], [/\bOperaciones de exportaci[oó]n\b/gi, 'Export Operations'],
    [/\bPropietari[oa]\b/gi, 'Owner'], [/\bCofundador(?:a)?\b/gi, 'Co-founder'], [/\bFundador(?:a)?\b/gi, 'Founder'], [/\bPresidente\b/gi, 'President'],
    [/\bDirector(?:a)? de flotas?\b/gi, 'Fleet Director'],
  ];
  const T_GEN = /\b(Director|Directora|Jefe|Jefa|Responsable|Gerente|Gestor|Gestora|Técnico|Tecnico|Técnica)\s+(?:de\s+(?:la\s+|los\s+|las\s+)?|del\s+)?([A-Za-zÁÉÍÓÚáéíóúñÑ]+(?:\s+(?:de\s+|y\s+)?[A-Za-zÁÉÍÓÚáéíóúñÑ]+)?)/gi;
  const _titleFmt = (role, tpl, d) => (/^director/i.test(role) && /^(Plant|Fleet|Store|Section)$/.test(d)) ? d + ' Director' : tpl.replace('%', d);
  function trTitleEn(s) {
    const s0 = s;
    let out = s;
    T_PHRASE.forEach(p => { out = out.replace(p[0], p[1]); });
    out = out.replace(T_GEN, (m, role, dom) => {
      const tpl = T_ROLE[role.toLowerCase()]; if (!tpl) return m;
      const low = dom.toLowerCase().replace(/\s+/g, ' ');
      if (T_DOM[low]) return _titleFmt(role, tpl, T_DOM[low]);
      const first = low.split(' ')[0];
      if (T_DOM[first]) return _titleFmt(role, tpl, T_DOM[first]) + dom.slice(first.length);
      return m;
    });
    // si quedan palabras en español sin traducir, mejor dejar el cargo original completo que mezclar idiomas
    if (out !== s0 && /\b(de|del|la|los|las|y|delegaci[oó]n|veh[ií]culos|Mtto|nacional|internacional)\b/.test(out)) return s0;
    return out;
  }
  function trNamesEn(s) {
    return s.replace(/Seguimiento de lista/g, 'List follow-up').replace(/Contacto directo/g, 'Direct outreach')
      .replace(/Comentario post-invitaci[oó]n/g, 'Post-invite comment').replace(/Alimentaci[oó]n y distribuci[oó]n/g, 'Food & distribution')
      .replace(/\bsemana (\d+)/g, 'week $1').replace(/\bSeguimiento\b/g, 'Follow-up');
  }
  let lang = 'es';
  try { lang = localStorage.getItem('pt_lang') || ''; } catch (e) {}
  // el enlace del correo trae ?lang=xx: el portal se abre ya en ese idioma (también en la pantalla de acceso)
  try { const m = location.pathname.match(/^\/(en|de|pt|es)\/portal(?:\/|$)/); const q = m ? m[1] : new URLSearchParams(location.search).get('lang'); if (q && LANGS[q]) { lang = q; localStorage.setItem('pt_lang', q); } } catch (e) {}
  if (!LANGS[lang]) { const n = (navigator.language || 'es').slice(0, 2).toLowerCase(); lang = n === 'es' ? 'es' : n === 'pt' ? 'pt' : (n === 'de' || n === 'fr' || n === 'it') ? 'de' : 'en'; }
  function tx(s) {
    if (!s) return s;
    const c0 = cleanTenure(s);                 // datos importados: quita "3 yrs 5 mos" / "N/A" del cargo
    if (lang === 'es') return c0;
    const t = c0.trim(); if (!t) return c0;
    const hit = EX[lang].get(t);
    if (hit) return c0.replace(t, hit);
    let out = c0;
    for (const r of R) { const to = r[IDX[lang]]; out = out.replace(r[0], to); }
    if (lang === 'en') out = trNamesEn(trTitleEn(out));   // cargos y nombres de secuencias
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
  window.PT_I18N = { LANGS, get lang() { return lang; }, t: tx, set, observe, apply: el => { try { walk(el); } catch (e) {} }, locale: () => LANGS[lang].locale };
})();
