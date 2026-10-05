import http from 'k6/http';
import { check, sleep } from 'k6';

// Function to test the 'About Us' API endpoint
export function testAboutUs() {
    const res = http.get('http://127.0.0.1:4001/api/settings/aboutUs'); // Replace with your API endpoint
    check(res, {
        'status was 200': (r) => r.status === 200,
        'response time was acceptable': (r) => r.timings.duration < 200, // Example of additional check
    });
    sleep(1);
}


// Function to test the 'Send Message' API endpoint
export function testSendMessage() {
    const conversationId = '66fb9fddc3853b1ebe5c112c'; // Replace with your actual conversation ID
    const url = `http://127.0.0.1:4001/api/conversation/${conversationId}/message`; // Replace with your API endpoint
  
    const messages = [
        "Hello, how are you?",
        "What's up?",
        "Good morning!",
        "Good evening!",
        "How's it going?",
        "Have a great day!",
        "Nice to meet you!",
        "See you soon!",
        "Take care!",
        "Goodbye!"
    ];
    const randomMessage = messages[Math.floor(Math.random() * messages.length)];
    const payload = JSON.stringify({
        messageType: "text",
        messageContent: randomMessage,
        mediaUrl: null
    });
    const params = {
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJfaWQiOiI2NmZjZjQzYTk1ZjM5MWFlOGM2ZWY2N2MiLCJpYXQiOjE3Mjc4NTM2NDF9.QQBtr4ogiSgy83JaUrk_pjhNKbs9G612CoPeXGuqwSk',

        },
    };
    const res = http.post(url, payload, params);
    
    if (res.status !== 201) {
        console.error(`Request failed with status ${res.status}: ${res.body}`);
    }
    
    check(res, {
        'status was 201': (r) => r.status === 201,
        'response time was acceptable': (r) => r.timings.duration < 500,
    });

    sleep(1);
}

// Main function to run specific tests
export default function () {
    //testAboutUs();
    testSendMessage();
}

// Configuration for k6 load test
// export const options = {
//     vus: 1000,           // Number of virtual users
//     duration: '20s',    // Duration for the test
//     http_req_timeout: '10s', // Increase timeout to 10 seconds

// };

export const options = {
    stages: [
        { duration: '10s', target: 250 }, // Ramp up to 250 VUs
        { duration: '10s', target: 1000 }, // Ramp up to 1000 VUs
        { duration: '5s', target: 0 },     // Ramp down
    ],
    http_req_timeout: '10s',
};
