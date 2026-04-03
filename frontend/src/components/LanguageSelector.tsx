import { useLanguage } from "@/contexts/LanguageContext";

export const LanguageSelector = () => {
  const { language, setLanguage } = useLanguage();

  return (
    <div className="flex gap-2 items-center">
      <button
        onClick={() => setLanguage('fr')}
        className={`text-base px-3 py-1.5 rounded transition-all border-2 ${
          language === 'fr' ? 'border-primary scale-105 opacity-100' : 'border-transparent opacity-50 hover:opacity-75'
        }`}
        style={{ aspectRatio: '3/2' }}
        title="Français"
      >
        🇫🇷
      </button>
      <button
        onClick={() => setLanguage('en')}
        className={`text-base px-3 py-1.5 rounded transition-all border-2 ${
          language === 'en' ? 'border-primary scale-105 opacity-100' : 'border-transparent opacity-50 hover:opacity-75'
        }`}
        style={{ aspectRatio: '3/2' }}
        title="English"
      >
        🇬🇧
      </button>
    </div>
  );
};
