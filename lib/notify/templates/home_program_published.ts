import { defineTemplate, idOf } from "./shared";

export default defineTemplate({
  name: "home_program_published",
  strings: {
    en: { title: "New home activities", body: "Your child's care team shared new activities to do at home." },
    hi: {
      title: "घर के लिए नई गतिविधियाँ",
      body: "आपके बच्चे की देखभाल टीम ने घर पर करने के लिए नई गतिविधियाँ साझा की हैं।",
    },
    te: {
      title: "ఇంటి కోసం కొత్త కార్యకలాపాలు",
      body: "మీ పిల్లల సంరక్షణ బృందం ఇంట్లో చేయడానికి కొత్త కార్యకలాపాలను పంచుకుంది.",
    },
  },
  link: ({ payload }) => {
    const childId = idOf(payload, "child_id");
    return childId ? `/family/children/${childId}` : "/family/children";
  },
});
