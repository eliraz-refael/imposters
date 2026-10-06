/** A form field as a string; a file upload or an absent field is undefined */
export const formString = (form: FormData, name: string): string | undefined => {
  const value = form.get(name)
  return typeof value === "string" ? value : undefined
}
