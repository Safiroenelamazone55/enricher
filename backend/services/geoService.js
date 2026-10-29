'use strict';

/**
 * geoService.js — país normalizado, país deducido de la ciudad/región e idioma del contacto.
 * Funciones puras (sin DB). Se usa desde el módulo de datos (limpiar país, enriquecer país e idioma).
 *
 * El idioma sale de la UBICACIÓN DEL CONTACTO (no de la empresa). Países con varios idiomas de negocio
 * (Bélgica, Suiza, Canadá…) no se adivinan: se resuelven por ciudad si hay una conocida, y si no quedan
 * "por revisar" (idioma vacío).
 */

const norm = s => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// [nombre canónico (inglés, como ya viene en los datos), ISO2, alias (es / nativos / variantes), idiomas por defecto ('' = ambiguo), candidatos si es ambiguo]
const C = [
  ['Spain', 'ES', ['espana', 'reino de espana'], 'es'],
  ['Mexico', 'MX', ['mejico', 'estados unidos mexicanos'], 'es'],
  ['Peru', 'PE', [], 'es'], ['Colombia', 'CO', [], 'es'], ['Chile', 'CL', [], 'es'], ['Argentina', 'AR', [], 'es'],
  ['Ecuador', 'EC', [], 'es'], ['Bolivia', 'BO', [], 'es'], ['Paraguay', 'PY', [], 'es'], ['Uruguay', 'UY', [], 'es'],
  ['Venezuela', 'VE', [], 'es'], ['Costa Rica', 'CR', [], 'es'], ['Panama', 'PA', [], 'es'], ['Guatemala', 'GT', [], 'es'],
  ['Honduras', 'HN', [], 'es'], ['El Salvador', 'SV', [], 'es'], ['Nicaragua', 'NI', [], 'es'], ['Cuba', 'CU', [], 'es'],
  ['Dominican Republic', 'DO', ['republica dominicana', 'rep dominicana'], 'es'], ['Puerto Rico', 'PR', [], 'es'],
  ['Equatorial Guinea', 'GQ', ['guinea ecuatorial'], 'es'],
  ['United States', 'US', ['usa', 'u s a', 'u s', 'us', 'united states of america', 'estados unidos', 'eeuu', 'ee uu', 'america'], 'en'],
  ['United Kingdom', 'GB', ['uk', 'u k', 'great britain', 'gran bretana', 'reino unido', 'england', 'inglaterra', 'scotland', 'escocia', 'wales', 'gales', 'northern ireland', 'irlanda del norte'], 'en'],
  ['Ireland', 'IE', ['irlanda', 'republic of ireland'], 'en'], ['Australia', 'AU', [], 'en'], ['New Zealand', 'NZ', ['nueva zelanda'], 'en'],
  ['Singapore', 'SG', ['singapur'], 'en'], ['South Africa', 'ZA', ['sudafrica'], 'en'], ['Nigeria', 'NG', [], 'en'], ['Kenya', 'KE', ['kenia'], 'en'],
  ['Ghana', 'GH', [], 'en'], ['Philippines', 'PH', ['filipinas'], 'en'], ['Malta', 'MT', [], 'en'], ['Jamaica', 'JM', [], 'en'],
  ['Hong Kong', 'HK', [], 'en'], ['Israel', 'IL', [], 'en'],
  ['India', 'IN', [], 'en'], ['Pakistan', 'PK', [], 'en'],
  ['Canada', 'CA', [], '', ['en', 'fr']],
  ['France', 'FR', ['francia'], 'fr'], ['Monaco', 'MC', [], 'fr'], ['Senegal', 'SN', [], 'fr'], ['Ivory Coast', 'CI', ['cote d ivoire', 'costa de marfil'], 'fr'],
  ['Cameroon', 'CM', ['camerun'], '', ['fr', 'en']], ['Haiti', 'HT', [], 'fr'],
  ['Belgium', 'BE', ['belgica', 'belgique', 'belgie'], '', ['nl', 'fr']],
  ['Switzerland', 'CH', ['suiza', 'suisse', 'schweiz', 'svizzera'], '', ['de', 'fr', 'it']],
  ['Luxembourg', 'LU', ['luxemburgo'], '', ['fr', 'de']],
  ['Germany', 'DE', ['alemania', 'deutschland'], 'de'], ['Austria', 'AT', ['osterreich'], 'de'], ['Liechtenstein', 'LI', [], 'de'],
  ['Italy', 'IT', ['italia'], 'it'], ['San Marino', 'SM', [], 'it'],
  ['Portugal', 'PT', [], 'pt'], ['Brazil', 'BR', ['brasil'], 'pt'], ['Angola', 'AO', [], 'pt'], ['Mozambique', 'MZ', ['mozambique'], 'pt'],
  ['Netherlands', 'NL', ['holland', 'holanda', 'paises bajos', 'nederland', 'the netherlands'], 'nl'],
  ['Sweden', 'SE', ['suecia', 'sverige'], 'sv'], ['Norway', 'NO', ['noruega', 'norge'], 'no'], ['Denmark', 'DK', ['dinamarca', 'danmark'], 'da'],
  ['Finland', 'FI', ['finlandia', 'suomi'], 'fi'], ['Iceland', 'IS', ['islandia'], 'en'],
  ['Poland', 'PL', ['polonia', 'polska'], 'pl'], ['Czech Republic', 'CZ', ['chequia', 'republica checa', 'czechia'], 'cs'],
  ['Slovakia', 'SK', ['eslovaquia'], 'sk'], ['Hungary', 'HU', ['hungria'], 'hu'], ['Romania', 'RO', ['rumania', 'rumania'], 'ro'],
  ['Bulgaria', 'BG', [], 'bg'], ['Greece', 'GR', ['grecia'], 'el'], ['Croatia', 'HR', ['croacia'], 'hr'], ['Serbia', 'RS', [], 'sr'],
  ['Slovenia', 'SI', ['eslovenia'], 'sl'], ['Estonia', 'EE', [], 'et'], ['Latvia', 'LV', ['letonia'], 'lv'], ['Lithuania', 'LT', ['lituania'], 'lt'],
  ['Ukraine', 'UA', ['ucrania'], 'uk'], ['Russia', 'RU', ['rusia'], 'ru'], ['Turkey', 'TR', ['turquia', 'turkiye'], 'tr'],
  ['Cyprus', 'CY', ['chipre'], '', ['el', 'en']],
  ['Morocco', 'MA', ['marruecos'], '', ['ar', 'fr']], ['Algeria', 'DZ', ['argelia'], '', ['ar', 'fr']], ['Tunisia', 'TN', ['tunez'], '', ['ar', 'fr']],
  ['Lebanon', 'LB', ['libano'], '', ['ar', 'fr']],
  ['Egypt', 'EG', ['egipto'], 'ar'], ['Saudi Arabia', 'SA', ['arabia saudita', 'arabia saudi', 'ksa'], 'ar'], ['United Arab Emirates', 'AE', ['uae', 'emiratos arabes unidos', 'emiratos', 'dubai'], '', ['ar', 'en']],
  ['Qatar', 'QA', ['catar'], '', ['ar', 'en']], ['Kuwait', 'KW', [], 'ar'], ['Bahrain', 'BH', ['barein'], 'ar'], ['Oman', 'OM', ['oman'], 'ar'],
  ['Jordan', 'JO', ['jordania'], 'ar'], ['Iraq', 'IQ', ['irak'], 'ar'], ['Libya', 'LY', ['libia'], 'ar'], ['Mauritania', 'MR', [], 'ar'],
  ['China', 'CN', [], 'zh'], ['Taiwan', 'TW', ['taiwan'], 'zh'], ['Japan', 'JP', ['japon'], 'ja'], ['South Korea', 'KR', ['corea del sur', 'korea'], 'ko'],
  ['Vietnam', 'VN', [], 'vi'], ['Thailand', 'TH', ['tailandia'], 'th'], ['Indonesia', 'ID', [], 'id'], ['Malaysia', 'MY', ['malasia'], '', ['ms', 'en']],
  ['Iran', 'IR', [], 'fa'], ['Bangladesh', 'BD', ['banglades'], 'bn'], ['Sri Lanka', 'LK', [], '', ['si', 'en']],
];
const BY_NAME = new Map(), BY_ISO = new Map(), BY_ALIAS = new Map();
for (const [name, iso, aliases, lang, cands] of C) {
  const o = { name, iso, lang, cands: cands || null };
  BY_NAME.set(norm(name), o); BY_ISO.set(iso, o);
  for (const a of aliases) BY_ALIAS.set(norm(a), o);
}
function findCountry(token) {
  const n = norm(token);
  if (!n) return null;
  return BY_NAME.get(n) || BY_ALIAS.get(n) || null;
}

// Ruido típico de LinkedIn/Apollo: "Spain Spain", "Greater Madrid Area", "Spain Area", "Madrid, Spain".
const NOISE = /\b(area|region|metropolitan|greater|province|provincia|metro)\b/gi;
function normalizeCountry(raw) {
  const s0 = String(raw == null ? '' : raw).trim();
  if (!s0) return s0;
  const parts = s0.split(/[,;|\/]/).map(x => x.trim()).filter(Boolean);
  const tryTok = t => {
    const cleaned = t.replace(NOISE, ' ').replace(/\s+/g, ' ').trim();
    let c = findCountry(cleaned);
    if (c) return c;
    const w = cleaned.split(' ');
    // palabra repetida: "Spain Spain" → "Spain"; o cola/cabeza que sea un país ("Spain Area" ya quedó "Spain")
    if (w.length > 1 && w.every(x => norm(x) === norm(w[0]))) c = findCountry(w[0]);
    if (!c && w.length > 1) c = findCountry(w.slice(-2).join(' ')) || findCountry(w[w.length - 1]) || findCountry(w[0]);
    if (!c && /^[A-Za-z]{2}$/.test(cleaned) && cleaned === cleaned.toUpperCase()) c = BY_ISO.get(cleaned);
    return c;
  };
  for (let i = parts.length - 1; i >= 0; i--) { const c = tryTok(parts[i]); if (c) return c.name; }
  return s0;   // no se reconoce: se deja tal cual (nunca se borra un dato)
}

// ── Ciudad / región → país ────────────────────────────────────────────────────
const CITIES = {};
function add(country, list) { for (const x of list) CITIES[norm(x)] = country; }
add('Spain', ['Madrid', 'Barcelona', 'Valencia', 'Sevilla', 'Seville', 'Zaragoza', 'Malaga', 'Murcia', 'Palma', 'Palma de Mallorca', 'Bilbao', 'Alicante', 'Elche', 'Torrevieja', 'Cartagena', 'Valladolid', 'Vigo', 'Gijon', 'Granada', 'A Coruna', 'La Coruna', 'Vitoria', 'Elda', 'Oviedo', 'Pamplona', 'San Sebastian', 'Donostia', 'Santander', 'Almeria', 'Castellon', 'Castellon de la Plana', 'Burgos', 'Albacete', 'Salamanca', 'Logrono', 'Badajoz', 'Huelva', 'Marbella', 'Benidorm', 'Gandia', 'Orihuela', 'Alcoy', 'Alcala de Henares', 'Getafe', 'Leganes', 'Mostoles', 'Terrassa', 'Sabadell', 'Hospitalet', "L'Hospitalet de Llobregat", 'Girona', 'Tarragona', 'Lleida', 'Reus', 'Las Palmas', 'Las Palmas de Gran Canaria', 'Tenerife', 'Santa Cruz de Tenerife', 'Ibiza', 'Menorca', 'Mallorca', 'Cadiz', 'Jerez', 'Jaen', 'Toledo', 'Cuenca', 'Segovia', 'Leon', 'Lugo', 'Ourense', 'Pontevedra', 'Santiago de Compostela', 'Merida', 'Caceres', 'Guadalajara de Henares', 'Torrent', 'Paterna', 'Dénia', 'Denia', 'Javea', 'Xàbia', 'Calpe', 'Altea', 'Villajoyosa', 'Santa Pola', 'Crevillent', 'Novelda', 'Aspe', 'Pilar de la Horadada', 'Lorca', 'Molina de Segura', 'Aguilas', 'San Javier', 'La Manga', 'Mazarron']);
add('Mexico', ['Ciudad de Mexico', 'Mexico City', 'CDMX', 'Monterrey', 'Tijuana', 'Puebla', 'Queretaro', 'Merida Yucatan', 'Cancun', 'Leon Guanajuato', 'Ciudad Juarez', 'San Luis Potosi', 'Aguascalientes', 'Toluca', 'Saltillo', 'Hermosillo', 'Chihuahua', 'Culiacan', 'Mexicali', 'Veracruz', 'Morelia', 'Oaxaca', 'Playa del Carmen', 'Jalisco', 'Nuevo Leon', 'Zapopan']);
add('Peru', ['Lima', 'Arequipa', 'Trujillo', 'Chiclayo', 'Piura', 'Cusco', 'Cuzco', 'Iquitos', 'Huancayo', 'Tacna', 'Callao', 'Chimbote', 'Ica', 'Cajamarca', 'San Isidro', 'Miraflores', 'Surco', 'Santiago de Surco', 'La Molina', 'San Borja']);
add('Colombia', ['Bogota', 'Medellin', 'Cali', 'Barranquilla', 'Cartagena de Indias', 'Bucaramanga', 'Pereira', 'Manizales', 'Santa Marta', 'Cucuta', 'Ibague']);
add('Chile', ['Santiago de Chile', 'Valparaiso', 'Concepcion', 'Vina del Mar', 'Antofagasta', 'Temuco', 'Rancagua', 'Puerto Montt', 'La Serena', 'Iquique']);
add('Argentina', ['Buenos Aires', 'Rosario', 'Mendoza', 'Tucuman', 'La Plata', 'Mar del Plata', 'Salta', 'Neuquen', 'Bariloche']);
add('Ecuador', ['Quito', 'Guayaquil', 'Cuenca Ecuador', 'Ambato', 'Manta']);
add('Uruguay', ['Montevideo', 'Punta del Este']);
add('Paraguay', ['Asuncion']);
add('Bolivia', ['La Paz', 'Santa Cruz de la Sierra', 'Cochabamba', 'Sucre']);
add('Venezuela', ['Caracas', 'Maracaibo', 'Maracay']);
add('Costa Rica', ['San Jose Costa Rica']);
add('Panama', ['Panama City', 'Ciudad de Panama', 'Panama Pacifico']);
add('Dominican Republic', ['Santo Domingo', 'Santiago de los Caballeros', 'Punta Cana']);
add('Guatemala', ['Guatemala City', 'Ciudad de Guatemala']);
add('United States', ['New York', 'New York City', 'NYC', 'Los Angeles', 'Chicago', 'Houston', 'Phoenix', 'Philadelphia', 'San Antonio', 'San Diego', 'Dallas', 'San Jose California', 'Austin', 'Jacksonville', 'San Francisco', 'Columbus', 'Fort Worth', 'Indianapolis', 'Charlotte', 'Seattle', 'Denver', 'Washington DC', 'Washington D C', 'Boston', 'Nashville', 'Detroit', 'Portland Oregon', 'Las Vegas', 'Memphis', 'Louisville', 'Baltimore', 'Milwaukee', 'Albuquerque', 'Tucson', 'Fresno', 'Sacramento', 'Atlanta', 'Miami', 'Orlando', 'Tampa', 'Raleigh', 'Minneapolis', 'Cleveland', 'Pittsburgh', 'Cincinnati', 'Kansas City', 'St Louis', 'Saint Louis', 'Salt Lake City', 'Oakland', 'Honolulu', 'Anchorage', 'Boca Raton', 'Fort Lauderdale', 'Scottsdale', 'Irvine', 'Palo Alto', 'Silicon Valley', 'Brooklyn', 'Newark', 'Jersey City', 'Stamford']);
add('United Kingdom', ['London', 'Manchester', 'Birmingham UK', 'Leeds', 'Glasgow', 'Liverpool', 'Edinburgh', 'Bristol', 'Sheffield', 'Newcastle', 'Nottingham', 'Cardiff', 'Belfast', 'Leicester', 'Reading', 'Oxford', 'Cambridge UK', 'Southampton', 'Brighton']);
add('Ireland', ['Dublin', 'Cork', 'Galway', 'Limerick']);
add('France', ['Paris', 'Marseille', 'Lyon', 'Toulouse', 'Nice', 'Nantes', 'Strasbourg', 'Montpellier', 'Bordeaux', 'Lille', 'Rennes', 'Grenoble', 'Toulon', 'Dijon', 'Angers']);
add('Germany', ['Berlin', 'Hamburg', 'Munich', 'Munchen', 'Cologne', 'Koln', 'Frankfurt', 'Frankfurt am Main', 'Stuttgart', 'Dusseldorf', 'Dortmund', 'Essen', 'Leipzig', 'Bremen', 'Dresden', 'Hannover', 'Nuremberg', 'Nurnberg']);
add('Italy', ['Rome', 'Roma', 'Milan', 'Milano', 'Naples', 'Napoli', 'Turin', 'Torino', 'Palermo', 'Genoa', 'Genova', 'Bologna', 'Florence', 'Firenze', 'Venice', 'Venezia', 'Verona', 'Padova', 'Bari', 'Catania']);
add('Portugal', ['Lisbon', 'Lisboa', 'Porto', 'Braga', 'Coimbra', 'Faro', 'Funchal', 'Aveiro', 'Setubal']);
add('Brazil', ['Sao Paulo', 'Rio de Janeiro', 'Brasilia', 'Salvador', 'Fortaleza', 'Belo Horizonte', 'Curitiba', 'Recife', 'Porto Alegre', 'Manaus', 'Campinas']);
add('Netherlands', ['Amsterdam', 'Rotterdam', 'The Hague', 'Den Haag', 'Utrecht', 'Eindhoven', 'Groningen', 'Tilburg']);
add('Sweden', ['Stockholm', 'Gothenburg', 'Goteborg', 'Malmo', 'Uppsala']);
add('Norway', ['Oslo', 'Bergen']); add('Denmark', ['Copenhagen', 'Kobenhavn', 'Aarhus']); add('Finland', ['Helsinki', 'Espoo', 'Tampere']);
add('Poland', ['Warsaw', 'Warszawa', 'Krakow', 'Wroclaw', 'Gdansk', 'Poznan', 'Lodz']);
add('Austria', ['Vienna', 'Wien', 'Graz', 'Salzburg', 'Linz', 'Innsbruck']);
add('Greece', ['Athens', 'Atenas', 'Thessaloniki']);
add('Turkey', ['Istanbul', 'Ankara', 'Izmir']);
add('Morocco', ['Casablanca', 'Rabat', 'Marrakech', 'Marrakesh', 'Tangier', 'Tanger', 'Fez', 'Agadir']);
add('Egypt', ['Cairo', 'El Cairo', 'Alexandria']);
add('Saudi Arabia', ['Riyadh', 'Jeddah', 'Dammam']);
add('United Arab Emirates', ['Dubai', 'Abu Dhabi', 'Sharjah']);
add('Qatar', ['Doha']);
add('India', ['Mumbai', 'Delhi', 'New Delhi', 'Bangalore', 'Bengaluru', 'Hyderabad', 'Chennai', 'Kolkata', 'Pune', 'Ahmedabad', 'Gurgaon', 'Gurugram', 'Noida', 'Jaipur', 'Surat', 'Kochi', 'Coimbatore', 'Aruba India']);
add('China', ['Beijing', 'Shanghai', 'Shenzhen', 'Guangzhou', 'Chengdu']);
add('Japan', ['Tokyo', 'Osaka', 'Kyoto', 'Yokohama']);
add('Singapore', ['Singapore']);
add('Australia', ['Sydney', 'Melbourne', 'Brisbane', 'Perth', 'Adelaide', 'Canberra']);
add('South Africa', ['Johannesburg', 'Cape Town', 'Durban', 'Pretoria']);
add('Aruba', ['Aruba', 'Oranjestad']);
// Países con varios idiomas: la CIUDAD decide (Québec/Montréal → francés, Zúrich → alemán…)
add('Canada', ['Toronto', 'Vancouver', 'Calgary', 'Edmonton', 'Ottawa', 'Winnipeg', 'Halifax', 'Montreal', 'Quebec', 'Quebec City', 'Laval', 'Gatineau', 'Sherbrooke', 'Mississauga', 'Brampton']);
add('Belgium', ['Brussels', 'Bruxelles', 'Bruselas', 'Antwerp', 'Antwerpen', 'Amberes', 'Ghent', 'Gent', 'Liege', 'Namur', 'Leuven', 'Charleroi', 'Bruges', 'Brugge']);
add('Switzerland', ['Zurich', 'Geneva', 'Geneve', 'Ginebra', 'Basel', 'Bern', 'Berne', 'Lausanne', 'Lugano', 'Lucerne', 'Luzern', 'St Gallen']);
add('Luxembourg', ['Luxembourg City', 'Ciudad de Luxemburgo']);
// nombres ambiguos a propósito NO incluidos: Cordoba, Santiago, San Jose, Guadalajara, Portland, Cambridge, London (ON), Birmingham (AL)

const CITY_LANG = {
  quebec: 'fr', 'quebec city': 'fr', montreal: 'fr', laval: 'fr', gatineau: 'fr', sherbrooke: 'fr',
  toronto: 'en', vancouver: 'en', calgary: 'en', edmonton: 'en', ottawa: 'en', winnipeg: 'en', halifax: 'en', mississauga: 'en', brampton: 'en',
  zurich: 'de', basel: 'de', bern: 'de', berne: 'de', lucerne: 'de', luzern: 'de', 'st gallen': 'de',
  geneva: 'fr', geneve: 'fr', ginebra: 'fr', lausanne: 'fr', lugano: 'it',
  antwerp: 'nl', antwerpen: 'nl', amberes: 'nl', ghent: 'nl', gent: 'nl', leuven: 'nl', bruges: 'nl', brugge: 'nl',
  liege: 'fr', namur: 'fr', charleroi: 'fr',
  'luxembourg city': 'fr', 'ciudad de luxemburgo': 'fr',
};
// Brussels es bilingüe de verdad: se deja "por revisar".

const US_STATES = { al: 1, ak: 1, az: 1, ar: 1, ca: 1, co: 1, ct: 1, de: 1, fl: 1, ga: 1, hi: 1, id: 1, il: 1, in: 1, ia: 1, ks: 1, ky: 1, la: 1, me: 1, md: 1, ma: 1, mi: 1, mn: 1, ms: 1, mo: 1, mt: 1, ne: 1, nv: 1, nh: 1, nj: 1, nm: 1, ny: 1, nc: 1, nd: 1, oh: 1, ok: 1, or: 1, pa: 1, ri: 1, sc: 1, sd: 1, tn: 1, tx: 1, ut: 1, vt: 1, va: 1, wa: 1, wv: 1, wi: 1, wy: 1 };
const US_STATE_NAMES = ['alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware', 'florida', 'georgia us', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire', 'new jersey', 'new mexico', 'new york', 'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania', 'rhode island', 'south carolina', 'south dakota', 'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington', 'west virginia', 'wisconsin', 'wyoming'];
const REGIONS = {};
for (const s of US_STATE_NAMES) REGIONS[s] = 'United States';
for (const r of ['comunidad valenciana', 'valencian community', 'region de murcia', 'murcia', 'andalucia', 'andalusia', 'cataluna', 'catalonia', 'catalunya', 'galicia', 'pais vasco', 'basque country', 'aragon', 'asturias', 'cantabria', 'castilla y leon', 'castilla la mancha', 'extremadura', 'la rioja', 'navarra', 'comunidad de madrid', 'islas baleares', 'balearic islands', 'canarias', 'canary islands', 'illes balears', 'alicante', 'alacant', 'castellon', 'granada', 'almeria']) REGIONS[r] = 'Spain';
for (const r of ['england', 'scotland', 'wales', 'northern ireland']) REGIONS[r] = 'United Kingdom';
for (const r of ['ontario', 'british columbia', 'alberta', 'manitoba', 'nova scotia', 'quebec', 'saskatchewan']) REGIONS[r] = 'Canada';
for (const r of ['bavaria', 'bayern', 'hesse', 'hessen', 'saxony', 'north rhine westphalia', 'baden wurttemberg']) REGIONS[r] = 'Germany';
for (const r of ['lombardy', 'lombardia', 'lazio', 'tuscany', 'toscana', 'sicily', 'sicilia', 'piedmont', 'veneto']) REGIONS[r] = 'Italy';

// País deducido de ciudad y/o región (null si no se puede con seguridad).
function countryFromPlace(ciudad, region) {
  const city = norm(String(ciudad || '').split(',')[0].replace(NOISE, ' '));
  const reg = norm(String(region || '').split(',')[0].replace(NOISE, ' '));
  // si el propio texto de ciudad/región es un país ("Spain Spain" en el campo ciudad)
  const asCountry = findCountry(String(ciudad || '').replace(NOISE, ' ')) || findCountry(String(region || '').replace(NOISE, ' '));
  if (asCountry) return asCountry.name;
  if (city && CITIES[city]) return CITIES[city];
  if (reg && REGIONS[reg]) return REGIONS[reg];
  if (reg && US_STATES[reg.replace(/\s/g, '')] && reg.length === 2) return 'United States';
  return null;
}

// Idioma por país (+ ciudad en los países con varios idiomas). Devuelve { lang, ambiguous, candidates }.
function languageFor(pais, ciudad) {
  const c = findCountry(pais) || findCountry(normalizeCountry(pais));
  if (!c) return { lang: '', ambiguous: false, candidates: [], unknown: true };
  const city = norm(String(ciudad || '').split(',')[0]);
  if (c.lang) return { lang: c.lang, ambiguous: false, candidates: [c.lang] };
  if (city && CITY_LANG[city]) return { lang: CITY_LANG[city], ambiguous: false, candidates: c.cands };
  return { lang: '', ambiguous: true, candidates: c.cands || [] };
}

const LANG_NAMES = { es: 'Español', en: 'Inglés', fr: 'Francés', de: 'Alemán', it: 'Italiano', pt: 'Portugués', nl: 'Neerlandés', ar: 'Árabe', sv: 'Sueco', no: 'Noruego', da: 'Danés', fi: 'Finés', pl: 'Polaco', cs: 'Checo', sk: 'Eslovaco', hu: 'Húngaro', ro: 'Rumano', bg: 'Búlgaro', el: 'Griego', hr: 'Croata', sr: 'Serbio', sl: 'Esloveno', et: 'Estonio', lv: 'Letón', lt: 'Lituano', uk: 'Ucraniano', ru: 'Ruso', tr: 'Turco', zh: 'Chino', ja: 'Japonés', ko: 'Coreano', vi: 'Vietnamita', th: 'Tailandés', id: 'Indonesio', ms: 'Malayo', fa: 'Persa', ca: 'Catalán', eu: 'Vasco', gl: 'Gallego', bn: 'Bengalí', si: 'Cingalés', tl: 'Filipino', he: 'Hebreo', hi: 'Hindi' };

// Idioma escrito de cualquier forma (código ISO, nombre en español/inglés/nativo) → el nombre en español que usa Nova ("Neerlandés", "Inglés"...).
// Lo que no se reconoce se deja tal cual (con la primera letra en mayúscula) para no perder lo que trajo el archivo.
const _LN_ALIAS = { english: 'en', ingles: 'en', spanish: 'es', espanol: 'es', castellano: 'es', french: 'fr', francais: 'fr', german: 'de', deutsch: 'de', italian: 'it', italiano: 'it', portuguese: 'pt', portugues: 'pt', dutch: 'nl', nederlands: 'nl', holandes: 'nl', arabic: 'ar', swedish: 'sv', svenska: 'sv', norwegian: 'no', norsk: 'no', danish: 'da', dansk: 'da', finnish: 'fi', suomi: 'fi', polish: 'pl', polski: 'pl', czech: 'cs', slovak: 'sk', hungarian: 'hu', romanian: 'ro', bulgarian: 'bg', greek: 'el', croatian: 'hr', serbian: 'sr', slovenian: 'sl', estonian: 'et', latvian: 'lv', lithuanian: 'lt', ukrainian: 'uk', russian: 'ru', turkish: 'tr', chinese: 'zh', mandarin: 'zh', japanese: 'ja', korean: 'ko', vietnamese: 'vi', thai: 'th', indonesian: 'id', malay: 'ms', persian: 'fa', farsi: 'fa', bengali: 'bn', sinhala: 'si', filipino: 'tl', tagalog: 'tl', pilipino: 'tl', hebrew: 'he', hindi: 'hi' };
// Nombres de idiomas en otros idiomas (italiano, portugués, francés, alemán, catalán): «Inglese», «Spagnolo», «Espanhol», «Anglais»… → el mismo idioma.
const _LN_MORE = {
  en: 'inglese anglais englisch anglès angles',
  es: 'spagnolo espanhol espagnol spanisch espanyol español espanol castellano castellà',
  fr: 'francese frances francais français franzosisch franzosisch franc',
  de: 'tedesco alemao allemand aleman alemany deutsch',
  it: 'italien italienisch italia',
  pt: 'portoghese portugais portugiesisch portugues portuguès',
  nl: 'olandese neerlandais neerlandes niederlandisch nederlands neerlandès',
  ar: 'arabo arabe arabisch',
  sv: 'svedese suedois sueco schwedisch suec',
  no: 'norvegese norvegien noruegues norwegisch noruec',
  da: 'danese danois dinamarques danisch danes',
  fi: 'finlandese finnois finlandes finnisch finlandès',
  pl: 'polacco polonais polones polnisch polonès',
  cs: 'ceco tcheque tcheco tschechisch txec checo',
  sk: 'slovacco slovaque eslovaco slowakisch',
  hu: 'ungherese hongrois hungaro ungarisch hongarès',
  ro: 'rumeno roumain romeno rumanisch romanès',
  bg: 'bulgaro bulgare bulgarisch',
  el: 'greco grec grego griechisch grec',
  hr: 'croato croate kroatisch',
  sr: 'serbo serbe servio serbisch',
  sl: 'sloveno slovene slowenisch',
  ru: 'russo russe russisch rus',
  tr: 'turco turc turkisch turc',
  zh: 'cinese chinois chines chinesisch xines',
  ja: 'giapponese japonais japones japanisch japonès',
  ko: 'coreano coreen koreanisch',
  fa: 'persiano persan persa persisch',
  bn: 'bengalese bengali bengalí',
  ca: 'catalano catalan catalao katalanisch català catala',
  eu: 'basco basque vasco euskera euskara baskisch',
  gl: 'galiziano galicien galego gallego galicisch',
};
for (const [c, ws] of Object.entries(_LN_MORE)) ws.split(/\s+/).forEach(w => { const k = w.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); if (k && !_LN_ALIAS[k]) _LN_ALIAS[k] = c; });
function normalizeLanguage(v) {
  const raw = String(v == null ? '' : v).trim(); if (!raw) return '';
  const k = norm(raw).replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();   // «Español (nativo)» → «español»
  const code = k.split(/[ _-]/)[0];
  if (LANG_NAMES[code] && k.length <= 5) return LANG_NAMES[code];
  if (_LN_ALIAS[k]) return LANG_NAMES[_LN_ALIAS[k]];
  const hit = Object.values(LANG_NAMES).find(n => norm(n) === k);
  if (hit) return hit;
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

// Idioma que PRIORIZA un contacto con varios idiomas y niveles (nativo > competencia completa > avanzado > profesional > limitado > elemental).
// Empate (o sin nivel): gana el que va primero en su lista. lista = [{idioma, nivel}] (o textos).
function _nivelRank(n) {
  const t = String(n || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (!t) return 0;
  if (/nativ|bilingual|bilingue|materna/.test(t)) return 100;
  if (/full professional|completa|fluent|fluido|c2|c1/.test(t)) return 85;
  if (/advanced|avanzad|upper|b2/.test(t)) return 75;
  if (/professional working|profesional|working|laboral|b1/.test(t)) return 60;
  if (/limited|limitad|intermedi/.test(t)) return 40;
  if (/elementary|basic|basico|elemental|a2|a1/.test(t)) return 20;
  return 10;
}
function bestLanguage(lista) {
  let a = lista;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch (_) { a = []; } }
  if (!Array.isArray(a) || !a.length) return '';
  let top = null, topR = -1;
  a.forEach((x, i) => {
    const nm = (x && typeof x === 'object') ? x.idioma : x; if (!nm) return;
    const r = _nivelRank(x && typeof x === 'object' ? x.nivel : '') ;
    if (r > topR) { topR = r; top = nm; }
  });
  return top ? normalizeLanguage(top) : '';
}

module.exports = { _nivelRank, bestLanguage, normalizeCountry, countryFromPlace, languageFor, findCountry, LANG_NAMES, normalizeLanguage };
