// Datos de contacto y texto de "Acerca de". Edita SOLO este archivo.
var ABOUT = {
  appName: 'EduPanel Docente',
  author: 'Michael Sevilla',
  email: '', // <-- escribe aquí tu correo de contacto (ej. 'nombre@correo.com')
  year: 2026,
  intention: [
    'Planear, evaluar y llevar el registro del grupo consume horas que cada docente preferiría dedicar a sus estudiantes. EduPanel Docente nació para devolver parte de ese tiempo: usa inteligencia artificial como apoyo para preparar borradores de planeamientos, evaluaciones y retroalimentación, siempre bajo el criterio profesional del docente.'
  ],
  principles: [
    ['El docente decide', 'La IA sugiere y tú revisas, corriges y decides. Ningún material debería usarse en el aula sin tu lectura.'],
    ['Pensado para tu contexto', 'Los materiales pueden adaptarse a la zona del centro y a las características generales del grupo.'],
    ['Privacidad primero', 'Tus datos y los de tus estudiantes se quedan en tu computador, cifrados y protegidos con PIN. No existe un servidor mío que los reciba.'],
    ['Tú eliges la IA', 'Usas tu propia clave del proveedor que prefieras (Claude, OpenAI o Gemini) y tú controlas el gasto.']
  ],
  disclaimer: 'EduPanel Docente es un proyecto independiente. No es una herramienta oficial del Ministerio de Educación Pública (MEP) ni está afiliada a él. Los programas de estudio y sus contenidos pertenecen al MEP. La IA puede equivocarse: revisa siempre lo que genera.'
};
if (typeof module !== 'undefined') module.exports = ABOUT;
