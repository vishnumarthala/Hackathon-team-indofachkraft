import { defineTemplate } from "./shared";

// 041 FR-8: platform admins review deletion requests (in-app + email; ids only).
export default defineTemplate({
  name: "privacy_deletion_requested",
  whatsapp: false,
  strings: {
    en: { title: "New data deletion request", body: "A family asked for their child's data to be deleted. Please review the request." },
    hi: { title: "डेटा हटाने का नया अनुरोध", body: "एक परिवार ने अपने बच्चे का डेटा हटाने का अनुरोध किया है। कृपया अनुरोध की समीक्षा करें।" },
    te: { title: "డేటా తొలగింపు కొత్త అభ్యర్థన", body: "ఒక కుటుంబం తమ పిల్లల డేటాను తొలగించమని కోరింది. దయచేసి అభ్యర్థనను సమీక్షించండి." },
  },
  link: () => "/admin/privacy/requests",
});
