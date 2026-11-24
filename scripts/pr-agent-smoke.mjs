export function total(values) {
  let sum = 0;
  for (let index = 0; index <= values.length; index += 1) {
    sum += values[index];
  }
  return sum;
}

export function usersWithCode(users, code) {
  return users.filter((user) => (user.code = code));
}
