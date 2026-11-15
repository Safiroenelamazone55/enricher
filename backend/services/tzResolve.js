'use strict';
// Texto libre ("India", "Madrid", "España, Madrid (GMT+1)") → zona horaria IANA. Misma tabla de capitales y ciudades que el selector del cliente en la app.
  const CAPITALS = [
    ['America/New_York', ['Nueva York', 'New York', 'Washington D. C.', 'Washington DC', 'Miami', 'Boston', 'Atlanta', 'Estados Unidos', 'United States', 'USA', 'EE. UU.']],
    ['America/Chicago', ['Chicago', 'Dallas', 'Houston', 'Austin', 'Nueva Orleans', 'New Orleans']], ['America/Denver', ['Denver', 'Salt Lake City']], ['America/Phoenix', ['Phoenix', 'Arizona']],
    ['America/Los_Angeles', ['Los Ángeles', 'Los Angeles', 'San Francisco', 'Seattle', 'Las Vegas', 'San Diego']], ['America/Anchorage', ['Alaska', 'Anchorage']], ['Pacific/Honolulu', ['Hawái', 'Hawaii', 'Honolulu']],
    ['America/Toronto', ['Toronto', 'Ottawa', 'Montreal', 'Canadá', 'Canada']], ['America/Vancouver', ['Vancouver', 'Calgary']],
    ['America/Mexico_City', ['Ciudad de México', 'Mexico City', 'CDMX', 'México', 'Mexico', 'Guadalajara', 'Monterrey']],
    ['America/Guatemala', ['Ciudad de Guatemala', 'Guatemala City', 'Guatemala']], ['America/El_Salvador', ['San Salvador', 'El Salvador']], ['America/Tegucigalpa', ['Tegucigalpa', 'Honduras']], ['America/Managua', ['Managua', 'Nicaragua']],
    ['America/Costa_Rica', ['San José (Costa Rica)', 'San Jose Costa Rica', 'Costa Rica']], ['America/Panama', ['Ciudad de Panamá', 'Panama City', 'Panamá', 'Panama']],
    ['America/Havana', ['La Habana', 'Havana', 'Cuba']], ['America/Santo_Domingo', ['Santo Domingo', 'República Dominicana', 'Dominican Republic']], ['America/Puerto_Rico', ['San Juan', 'Puerto Rico']],
    ['America/Jamaica', ['Kingston', 'Jamaica']], ['America/Port-au-Prince', ['Puerto Príncipe', 'Port-au-Prince', 'Haití', 'Haiti']],
    ['America/Bogota', ['Bogotá', 'Bogota', 'Colombia', 'Medellín', 'Medellin']], ['America/Caracas', ['Caracas', 'Venezuela']], ['America/Guayaquil', ['Quito', 'Guayaquil', 'Ecuador']],
    ['America/Lima', ['Lima', 'Perú', 'Peru']], ['America/La_Paz', ['La Paz', 'Sucre', 'Bolivia']], ['America/Santiago', ['Santiago de Chile', 'Santiago', 'Chile']],
    ['America/Argentina/Buenos_Aires', ['Buenos Aires', 'Argentina']], ['America/Montevideo', ['Montevideo', 'Uruguay']], ['America/Asuncion', ['Asunción', 'Asuncion', 'Paraguay']],
    ['America/Sao_Paulo', ['São Paulo', 'Sao Paulo', 'Brasilia', 'Brasília', 'Río de Janeiro', 'Rio de Janeiro', 'Brasil', 'Brazil']], ['America/Guyana', ['Georgetown', 'Guyana']], ['America/Paramaribo', ['Paramaribo', 'Surinam', 'Suriname']],
    ['Europe/Madrid', ['Madrid', 'Barcelona', 'España', 'Spain']], ['Atlantic/Canary', ['Islas Canarias', 'Canary Islands', 'Las Palmas']], ['Europe/Lisbon', ['Lisboa', 'Lisbon', 'Portugal', 'Oporto', 'Porto']],
    ['Europe/Paris', ['París', 'Paris', 'Francia', 'France']], ['Europe/London', ['Londres', 'London', 'Reino Unido', 'United Kingdom', 'UK', 'Inglaterra', 'England']], ['Europe/Dublin', ['Dublín', 'Dublin', 'Irlanda', 'Ireland']],
    ['Europe/Brussels', ['Bruselas', 'Brussels', 'Bélgica', 'Belgium']], ['Europe/Amsterdam', ['Ámsterdam', 'Amsterdam', 'Países Bajos', 'Netherlands', 'Holanda', 'Holland']], ['Europe/Luxembourg', ['Luxemburgo', 'Luxembourg']],
    ['Europe/Berlin', ['Berlín', 'Berlin', 'Alemania', 'Germany', 'Múnich', 'Munich', 'Fráncfort', 'Frankfurt']], ['Europe/Zurich', ['Zúrich', 'Zurich', 'Berna', 'Bern', 'Suiza', 'Switzerland', 'Ginebra', 'Geneva']],
    ['Europe/Vienna', ['Viena', 'Vienna', 'Austria']], ['Europe/Rome', ['Roma', 'Rome', 'Italia', 'Italy', 'Milán', 'Milan']], ['Europe/Malta', ['La Valeta', 'Valletta', 'Malta']],
    ['Europe/Athens', ['Atenas', 'Athens', 'Grecia', 'Greece']], ['Europe/Stockholm', ['Estocolmo', 'Stockholm', 'Suecia', 'Sweden']], ['Europe/Oslo', ['Oslo', 'Noruega', 'Norway']],
    ['Europe/Copenhagen', ['Copenhague', 'Copenhagen', 'Dinamarca', 'Denmark']], ['Europe/Helsinki', ['Helsinki', 'Finlandia', 'Finland']], ['Atlantic/Reykjavik', ['Reikiavik', 'Reykjavik', 'Islandia', 'Iceland']],
    ['Europe/Warsaw', ['Varsovia', 'Warsaw', 'Polonia', 'Poland']], ['Europe/Prague', ['Praga', 'Prague', 'República Checa', 'Chequia', 'Czech Republic', 'Czechia']], ['Europe/Bratislava', ['Bratislava', 'Eslovaquia', 'Slovakia']],
    ['Europe/Budapest', ['Budapest', 'Hungría', 'Hungary']], ['Europe/Bucharest', ['Bucarest', 'Bucharest', 'Rumanía', 'Romania']], ['Europe/Sofia', ['Sofía', 'Sofia', 'Bulgaria']],
    ['Europe/Belgrade', ['Belgrado', 'Belgrade', 'Serbia']], ['Europe/Zagreb', ['Zagreb', 'Croacia', 'Croatia']], ['Europe/Ljubljana', ['Liubliana', 'Ljubljana', 'Eslovenia', 'Slovenia']],
    ['Europe/Kyiv', ['Kiev', 'Kyiv', 'Ucrania', 'Ukraine']], ['Europe/Moscow', ['Moscú', 'Moscow', 'Rusia', 'Russia']], ['Europe/Minsk', ['Minsk', 'Bielorrusia', 'Belarus']],
    ['Europe/Vilnius', ['Vilna', 'Vilnius', 'Lituania', 'Lithuania']], ['Europe/Riga', ['Riga', 'Letonia', 'Latvia']], ['Europe/Tallinn', ['Tallin', 'Tallinn', 'Estonia']],
    ['Europe/Istanbul', ['Estambul', 'Istanbul', 'Ankara', 'Turquía', 'Turkey', 'Türkiye']],
    ['Africa/Cairo', ['El Cairo', 'Cairo', 'Egipto', 'Egypt']], ['Africa/Casablanca', ['Rabat', 'Casablanca', 'Marruecos', 'Morocco']], ['Africa/Algiers', ['Argel', 'Algiers', 'Argelia', 'Algeria']],
    ['Africa/Tunis', ['Túnez', 'Tunis', 'Tunisia']], ['Africa/Lagos', ['Lagos', 'Abuya', 'Abuja', 'Nigeria']], ['Africa/Accra', ['Acra', 'Accra', 'Ghana']], ['Africa/Dakar', ['Dakar', 'Senegal']],
    ['Africa/Nairobi', ['Nairobi', 'Kenia', 'Kenya']], ['Africa/Addis_Ababa', ['Adís Abeba', 'Addis Ababa', 'Etiopía', 'Ethiopia']], ['Africa/Johannesburg', ['Johannesburgo', 'Johannesburg', 'Pretoria', 'Ciudad del Cabo', 'Cape Town', 'Sudáfrica', 'South Africa']],
    ['Asia/Jerusalem', ['Jerusalén', 'Jerusalem', 'Tel Aviv', 'Israel']], ['Asia/Beirut', ['Beirut', 'Líbano', 'Lebanon']], ['Asia/Amman', ['Amán', 'Amman', 'Jordania', 'Jordan']],
    ['Asia/Riyadh', ['Riad', 'Riyadh', 'Arabia Saudita', 'Saudi Arabia']], ['Asia/Dubai', ['Dubái', 'Dubai', 'Abu Dabi', 'Abu Dhabi', 'Emiratos Árabes', 'UAE', 'Emiratos']], ['Asia/Qatar', ['Doha', 'Catar', 'Qatar']],
    ['Asia/Kuwait', ['Kuwait']], ['Asia/Baghdad', ['Bagdad', 'Baghdad', 'Irak', 'Iraq']], ['Asia/Tehran', ['Teherán', 'Tehran', 'Irán', 'Iran']],
    ['Asia/Karachi', ['Karachi', 'Islamabad', 'Pakistán', 'Pakistan']], ['Asia/Kolkata', ['Nueva Delhi', 'New Delhi', 'Delhi', 'Bombay', 'Mumbai', 'Calcuta', 'Kolkata', 'Calcutta', 'Bangalore', 'India']], ['Asia/Dhaka', ['Daca', 'Dhaka', 'Bangladés', 'Bangladesh']],
    ['Asia/Kathmandu', ['Katmandú', 'Kathmandu', 'Nepal']], ['Asia/Colombo', ['Colombo', 'Sri Lanka']], ['Asia/Bangkok', ['Bangkok', 'Tailandia', 'Thailand']],
    ['Asia/Ho_Chi_Minh', ['Hanói', 'Hanoi', 'Ho Chi Minh', 'Vietnam']], ['Asia/Jakarta', ['Yakarta', 'Jakarta', 'Indonesia']], ['Asia/Kuala_Lumpur', ['Kuala Lumpur', 'Malasia', 'Malaysia']],
    ['Asia/Singapore', ['Singapur', 'Singapore']], ['Asia/Manila', ['Manila', 'Filipinas', 'Philippines']], ['Asia/Shanghai', ['Pekín', 'Beijing', 'Shanghái', 'Shanghai', 'China']],
    ['Asia/Hong_Kong', ['Hong Kong']], ['Asia/Taipei', ['Taipéi', 'Taipei', 'Taiwán', 'Taiwan']], ['Asia/Seoul', ['Seúl', 'Seoul', 'Corea del Sur', 'South Korea', 'Corea', 'Korea']],
    ['Asia/Tokyo', ['Tokio', 'Tokyo', 'Japón', 'Japan', 'Osaka']], ['Asia/Ulaanbaatar', ['Ulán Bator', 'Ulaanbaatar', 'Mongolia']], ['Asia/Tashkent', ['Taskent', 'Tashkent', 'Uzbekistán', 'Uzbekistan']],
    ['Asia/Almaty', ['Almaty', 'Astaná', 'Astana', 'Kazajistán', 'Kazakhstan']],
    ['Australia/Sydney', ['Sídney', 'Sydney', 'Canberra', 'Australia']], ['Australia/Melbourne', ['Melbourne']], ['Australia/Brisbane', ['Brisbane']], ['Australia/Perth', ['Perth']], ['Australia/Adelaide', ['Adelaida', 'Adelaide']],
    ['Pacific/Auckland', ['Wellington', 'Auckland', 'Nueva Zelanda', 'New Zealand']], ['Pacific/Fiji', ['Suva', 'Fiyi', 'Fiji']],
    ['UTC', ['UTC', 'GMT', 'Hora universal']],
  ];
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[_/.,()-]+/g, ' ').replace(/\s+/g, ' ').trim();
const valid = tz => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (_) { return false; } };
const INDEX = [];
CAPITALS.forEach(([tz, names]) => names.forEach(n => INDEX.push({ tz, n: norm(n) })));
INDEX.sort((x, y) => y.n.length - x.n.length);
function resolveTz(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  if (raw.includes('/') && valid(raw)) return raw;
  const m = raw.match(/(?:gmt|utc)\s*([+-])\s*(\d{1,2})/i);
  const t = ' ' + norm(raw) + ' ';
  for (const e of INDEX) if (e.tz !== 'UTC' && e.n && t.includes(' ' + e.n + ' ')) return e.tz;
  if (m) { const h = parseInt(m[2], 10); if (h >= 0 && h <= 14) return h === 0 ? 'UTC' : 'Etc/GMT' + (m[1] === '+' ? '-' : '+') + h; }
  return INDEX.some(e => e.tz === 'UTC' && t.includes(' ' + e.n + ' ')) ? 'UTC' : '';
}
module.exports = { resolveTz, valid };
